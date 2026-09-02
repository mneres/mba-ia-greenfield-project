import { randomUUID } from 'crypto';
import { Readable } from 'stream';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { Upload } from '@tus/utils';
import type { S3Store } from '@tus/s3-store';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { videoSourceKey } from '../storage/storage.keys';
import {
  ALL_ENTITIES,
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import {
  REAPER_SCHEDULER_ID,
  VIDEO_PROCESSING_QUEUE,
} from '../videos/videos.constants';
import { VideosService } from '../videos/videos.service';
import { createTusS3Store } from '../videos/tus-store.factory';
import { ReaperProcessor } from './reaper.processor';

/**
 * Roda contra MinIO, Postgres e Redis reais. Vive sob `src/worker/` como
 * `*.integration-spec.ts`, entao executa no container `video-worker`.
 */

/** Janela curta o suficiente para que "expirado" seja alcancavel no teste. */
const EXPIRATION_HOURS = 0.001; // 3.6 segundos

describe('ReaperProcessor (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let storage: StorageService;
  let reaper: ReaperProcessor;
  let queue: Queue;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);

    const realStorage = storageConfig();

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        BullModule.forRootAsync({
          inject: [queueConfig.KEY],
          useFactory: (cfg: { host: string; port: number }) => ({
            connection: { host: cfg.host, port: cfg.port },
          }),
          extraOptions: { manualRegistration: true },
        }),
        BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
        StorageModule,
      ],
      providers: [
        ReaperProcessor,
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        {
          provide: storageConfig.KEY,
          useValue: { ...realStorage, uploadExpirationHours: EXPIRATION_HOURS },
        },
      ],
    }).compile();

    await moduleRef.init();
    storage = moduleRef.get(StorageService);
    reaper = moduleRef.get(ReaperProcessor);
    queue = moduleRef.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
  }, 60000);

  afterAll(async () => {
    await queue.removeJobScheduler(REAPER_SCHEDULER_ID).catch(() => undefined);
    await queue.close();
    await dataSource.destroy();
  });

  let counter = 0;
  let channelId: string;

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    counter += 1;

    const user = await dataSource.getRepository(User).save({
      email: `reaper-${counter}@example.com`,
      password: 'hashed',
    });
    const channel = await dataSource.getRepository(Channel).save({
      name: `Channel ${counter}`,
      nickname: `reaper_${counter}`,
      user_id: user.id,
    });
    channelId = channel.id;
  });

  let publicIdCounter = 0;
  /** Cria uma row de upload em andamento, opcionalmente envelhecida. */
  async function seedUpload(
    status: VideoStatus,
    ageHours: number,
  ): Promise<Video> {
    publicIdCounter += 1;
    const id = randomUUID();
    const video = await videoRepository.save(
      videoRepository.create({
        id,
        public_id: `r${String(publicIdCounter).padStart(10, '0')}`,
        channel_id: channelId,
        title: 'Upload em andamento',
        status,
        upload_id: videoSourceKey(id, '.mp4'),
      }),
    );

    if (ageHours > 0) {
      // `created_at` e gerido pelo TypeORM; envelhecer exige UPDATE direto.
      await dataSource.query(
        `UPDATE videos SET created_at = NOW() - INTERVAL '${ageHours} hours' WHERE id = $1`,
        [video.id],
      );
    }

    return videoRepository.findOneByOrFail({ id: video.id });
  }

  describe('stale rows', () => {
    it('should fail an upload abandoned past the expiration window', async () => {
      const video = await seedUpload(VideoStatus.UPLOADING, 1);

      const result = await reaper.reap();

      expect(result.videosFailed).toBe(1);
      const reaped = await videoRepository.findOneByOrFail({ id: video.id });
      expect(reaped.status).toBe(VideoStatus.FAILED);
      expect(reaped.processing_error).toContain('abandoned');
    });

    it('should preserve the row and its public_id as evidence of the attempt', async () => {
      const video = await seedUpload(VideoStatus.DRAFT, 1);
      const originalPublicId = video.public_id;

      await reaper.reap();

      const reaped = await videoRepository.findOneByOrFail({ id: video.id });
      expect(reaped.public_id).toBe(originalPublicId);
      expect(await videoRepository.count()).toBe(1);
    });

    it('should reap a draft that never received a byte', async () => {
      await seedUpload(VideoStatus.DRAFT, 1);

      const result = await reaper.reap();

      expect(result.videosFailed).toBe(1);
    });

    it('should leave an upload still inside the window untouched', async () => {
      const video = await seedUpload(VideoStatus.UPLOADING, 0);

      const result = await reaper.reap();

      expect(result.videosFailed).toBe(0);
      const untouched = await videoRepository.findOneByOrFail({ id: video.id });
      expect(untouched.status).toBe(VideoStatus.UPLOADING);
      expect(untouched.processing_error).toBeNull();
    });

    it('should not touch videos that already finished', async () => {
      // `ready`, `processing` e `failed` nao esperam bytes: nao ha o que
      // recolher, e `ready`/`failed` sao terminais por TD-05.
      for (const status of [
        VideoStatus.READY,
        VideoStatus.PROCESSING,
        VideoStatus.FAILED,
      ]) {
        await seedUpload(status, 5);
      }

      const result = await reaper.reap();

      expect(result.videosFailed).toBe(0);
      expect(await videoRepository.countBy({ status: VideoStatus.READY })).toBe(
        1,
      );
    });

    it('should be safe to run twice over the same upload', async () => {
      await seedUpload(VideoStatus.UPLOADING, 1);

      const first = await reaper.reap();
      const second = await reaper.reap();

      expect(first.videosFailed).toBe(1);
      // Ja em `failed`, que e terminal: a segunda passagem nao o reencontra
      // nem tenta uma transicao invalida.
      expect(second.videosFailed).toBe(0);
    });
  });

  describe('storage cleanup', () => {
    let store: S3Store;

    beforeAll(() => {
      // Mesmo store que o reaper usa, para semear um upload incompleto de
      // verdade em vez de presumir que havia algo a recolher.
      store = createTusS3Store({
        ...storageConfig(),
        uploadExpirationHours: EXPIRATION_HOURS,
      });
    });

    /** Cria um multipart incompleto: criado, com bytes parciais, nunca fechado. */
    async function seedIncompleteUpload(): Promise<string> {
      const key = videoSourceKey(randomUUID(), '.mp4');
      await store.create(
        new Upload({ id: key, size: 10_000, offset: 0, metadata: {} }),
      );
      await store.write(Readable.from([Buffer.from('partial')]), key, 0);
      return key;
    }

    it('should remove the parts of an upload abandoned past the window', async () => {
      const key = await seedIncompleteUpload();
      expect(
        (await storage.listObjectKeys(storage.videosBucket, key)).length,
      ).toBeGreaterThan(0);

      // A janela de expiracao do teste e de 3.6s.
      await new Promise((resolve) => setTimeout(resolve, 4500));
      const result = await reaper.reap();

      expect(result.objectsRemoved).toBeGreaterThanOrEqual(1);
      expect(await storage.listObjectKeys(storage.videosBucket, key)).toEqual(
        [],
      );
    }, 30000);

    it('should leave an upload still inside the window in place', async () => {
      const key = await seedIncompleteUpload();

      const result = await reaper.reap();

      expect(result.objectsRemoved).toBe(0);
      expect(
        (await storage.listObjectKeys(storage.videosBucket, key)).length,
      ).toBeGreaterThan(0);

      await store.remove(key);
    }, 30000);

    it('should not error on a second pass over an already reaped upload', async () => {
      await seedIncompleteUpload();
      await new Promise((resolve) => setTimeout(resolve, 4500));

      await reaper.reap();
      const second = await reaper.reap();

      expect(second.objectsRemoved).toBe(0);
    }, 30000);
  });

  describe('scheduler registration', () => {
    it('should leave a single scheduler after repeated worker boots', async () => {
      await reaper.registerSchedule();
      await reaper.registerSchedule();

      const schedulers = await queue.getJobSchedulers();
      const ours = schedulers.filter((s) => s.key === REAPER_SCHEDULER_ID);
      expect(ours).toHaveLength(1);
    });

    it('should schedule the reap job name, not the processing one', async () => {
      await reaper.registerSchedule();

      const schedulers = await queue.getJobSchedulers();
      const ours = schedulers.find((s) => s.key === REAPER_SCHEDULER_ID);
      expect(ours?.name).toBe('reap');
    });
  });
});
