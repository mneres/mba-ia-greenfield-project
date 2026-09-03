import { writeFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Job, UnrecoverableError } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { videoThumbnailKey, videoSourceKey } from '../storage/storage.keys';
import {
  ALL_ENTITIES,
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import type { VideoProcessJobData } from '../videos/video-queue.service';
import { VideosService } from '../videos/videos.service';
import { probe, findVideoStream } from './ffmpeg.util';
import { ReaperProcessor } from './reaper.processor';
import { VideoProcessor } from './video.processor';

/**
 * Pipeline completo contra MinIO e Postgres reais. **Só passa no container
 * `video-worker`** — depende dos binários de FFmpeg (per `TD-08`).
 *
 *   docker compose exec video-worker npm run test:worker
 */

const FIXTURES = join(__dirname, '..', 'test', 'fixtures');
const SAMPLE_VIDEO = join(FIXTURES, 'sample.mp4');
const SAMPLE_AUDIO = join(FIXTURES, 'sample-audio.m4a');

/** Só os campos que o processor lê. */
const fakeJob = (
  videoId: string,
  overrides: Partial<{ attemptsMade: number; attempts: number }> = {},
): Job<VideoProcessJobData> =>
  ({
    data: { videoId },
    attemptsMade: overrides.attemptsMade ?? 1,
    opts: { attempts: overrides.attempts ?? 3 },
  }) as Job<VideoProcessJobData>;

describe('VideoProcessor (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let storage: StorageService;
  let processor: VideoProcessor;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
      providers: [
        VideoProcessor,
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        // Esta suíte exercita só o pipeline de vídeo; o recolhimento tem a
        // própria spec, e instanciar o reaper aqui exigiria fila e S3Store.
        {
          provide: ReaperProcessor,
          useValue: { reap: jest.fn() } as unknown as ReaperProcessor,
        },
      ],
    }).compile();

    await moduleRef.init();
    storage = moduleRef.get(StorageService);
    processor = moduleRef.get(VideoProcessor);
  }, 60000);

  afterAll(async () => {
    await dataSource.destroy();
  });

  let counter = 0;
  let channelId: string;

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    counter += 1;

    const user = await dataSource.getRepository(User).save({
      email: `processor-${counter}@example.com`,
      password: 'hashed',
    });
    const channel = await dataSource.getRepository(Channel).save({
      name: `Channel ${counter}`,
      nickname: `processor_${counter}`,
      user_id: user.id,
    });
    channelId = channel.id;
  });

  /** Sobe a fixture no bucket privado e cria a row já em `processing`. */
  async function seedProcessingVideo(fixturePath: string): Promise<Video> {
    const video = await videoRepository.save(
      videoRepository.create({
        public_id: `p${String(counter).padStart(10, '0')}`,
        channel_id: channelId,
        title: 'Em processamento',
        status: VideoStatus.PROCESSING,
      }),
    );

    const key = videoSourceKey(video.id, '.mp4');
    await storage.putObject(
      storage.videosBucket,
      key,
      await readFile(fixturePath),
    );

    video.upload_id = key;
    return videoRepository.save(video);
  }

  async function thumbnailKeys(videoId: string): Promise<string[]> {
    return storage.listObjectKeys(
      storage.thumbnailsBucket,
      videoThumbnailKey(videoId),
    );
  }

  describe('successful processing', () => {
    it('should reach ready with typed metadata and the full ffprobe payload', async () => {
      const seeded = await seedProcessingVideo(SAMPLE_VIDEO);

      await processor.process(fakeJob(seeded.id));

      const video = await videoRepository.findOneByOrFail({ id: seeded.id });
      expect(video.status).toBe(VideoStatus.READY);
      expect(video.duration).toBeCloseTo(2, 0);
      expect(video.width).toBe(640);
      expect(video.height).toBe(360);
      expect(video.ffprobe_metadata).not.toBeNull();
      expect(video.processing_error).toBeNull();
    });

    it('should keep the whole ffprobe output, not just the three columns', async () => {
      const seeded = await seedProcessingVideo(SAMPLE_VIDEO);

      await processor.process(fakeJob(seeded.id));

      const video = await videoRepository.findOneByOrFail({ id: seeded.id });
      const metadata = video.ffprobe_metadata as unknown as {
        streams: { codec_type?: string }[];
      };
      // O áudio da fixture só está aqui porque o payload inteiro foi gravado.
      expect(metadata.streams.map((s) => s.codec_type).sort()).toEqual([
        'audio',
        'video',
      ]);
    });

    it('should write exactly one readable thumbnail at the deterministic key', async () => {
      const seeded = await seedProcessingVideo(SAMPLE_VIDEO);

      await processor.process(fakeJob(seeded.id));

      const keys = await thumbnailKeys(seeded.id);
      expect(keys).toEqual([videoThumbnailKey(seeded.id)]);

      const bytes = await storage.getObjectBuffer(
        storage.thumbnailsBucket,
        keys[0],
      );
      expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    });

    it('should serve the thumbnail anonymously', async () => {
      const seeded = await seedProcessingVideo(SAMPLE_VIDEO);

      await processor.process(fakeJob(seeded.id));

      // Sem credenciais: o bucket de thumbnails é público por TD-02.
      const response = await fetch(
        `${process.env.STORAGE_ENDPOINT}/${storage.thumbnailsBucket}/${videoThumbnailKey(seeded.id)}`,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/jpeg');
    });

    it('should overwrite the thumbnail on reprocessing instead of adding one', async () => {
      const seeded = await seedProcessingVideo(SAMPLE_VIDEO);
      await processor.process(fakeJob(seeded.id));

      // `ready` é terminal, então reprocessar exige voltar a `processing` —
      // é o que um retry do BullMQ enxergaria após uma falha transitória.
      await videoRepository.update(
        { id: seeded.id },
        { status: VideoStatus.PROCESSING },
      );
      await processor.process(fakeJob(seeded.id));

      expect(await thumbnailKeys(seeded.id)).toHaveLength(1);
    });

    it('should be a no-op for a video already ready', async () => {
      const seeded = await seedProcessingVideo(SAMPLE_VIDEO);
      await processor.process(fakeJob(seeded.id));
      await storage.deleteObject(
        storage.thumbnailsBucket,
        videoThumbnailKey(seeded.id),
      );

      await processor.process(fakeJob(seeded.id));

      // Não regravou: o job duplicado saiu cedo em vez de reprocessar.
      expect(await thumbnailKeys(seeded.id)).toHaveLength(0);
    });
  });

  describe('permanent rejection', () => {
    it('should fail an audio-only upload without burning the retry budget', async () => {
      const seeded = await seedProcessingVideo(SAMPLE_AUDIO);

      await expect(processor.process(fakeJob(seeded.id))).rejects.toThrow(
        UnrecoverableError,
      );

      const video = await videoRepository.findOneByOrFail({ id: seeded.id });
      expect(video.status).toBe(VideoStatus.FAILED);
      expect(video.processing_error).toContain('no video stream');
    });

    it('should keep the row and its public_id when it fails', async () => {
      const seeded = await seedProcessingVideo(SAMPLE_AUDIO);
      const originalPublicId = seeded.public_id;

      await expect(processor.process(fakeJob(seeded.id))).rejects.toThrow();

      const video = await videoRepository.findOneByOrFail({ id: seeded.id });
      expect(video.public_id).toBe(originalPublicId);
      expect(await videoRepository.count()).toBe(1);
    });

    it('should write no thumbnail for a rejected upload', async () => {
      const seeded = await seedProcessingVideo(SAMPLE_AUDIO);

      await expect(processor.process(fakeJob(seeded.id))).rejects.toThrow();

      expect(await thumbnailKeys(seeded.id)).toHaveLength(0);
    });

    it('should reject unrecoverably when the row no longer exists', async () => {
      await expect(
        processor.process(fakeJob('00000000-0000-0000-0000-000000000000')),
      ).rejects.toThrow(UnrecoverableError);
    });

    it('should reject unrecoverably when the row carries no upload_id', async () => {
      const video = await videoRepository.save(
        videoRepository.create({
          public_id: 'noupload001',
          channel_id: channelId,
          title: 'Sem upload_id',
          status: VideoStatus.PROCESSING,
        }),
      );

      await expect(processor.process(fakeJob(video.id))).rejects.toThrow(
        UnrecoverableError,
      );
    });
  });

  describe('retry exhaustion', () => {
    it('should not mark the video failed while attempts remain', async () => {
      const seeded = await seedProcessingVideo(SAMPLE_VIDEO);

      await processor.onFailed(
        fakeJob(seeded.id, { attemptsMade: 1, attempts: 3 }),
        new Error('transient storage hiccup'),
      );

      const video = await videoRepository.findOneByOrFail({ id: seeded.id });
      expect(video.status).toBe(VideoStatus.PROCESSING);
      expect(video.processing_error).toBeNull();
    });

    it('should mark the video failed with the reason on the last attempt', async () => {
      const seeded = await seedProcessingVideo(SAMPLE_VIDEO);

      await processor.onFailed(
        fakeJob(seeded.id, { attemptsMade: 3, attempts: 3 }),
        new Error('ffmpeg exited with code 1: broken pipe'),
      );

      const video = await videoRepository.findOneByOrFail({ id: seeded.id });
      expect(video.status).toBe(VideoStatus.FAILED);
      expect(video.processing_error).toContain('broken pipe');
    });
  });

  describe('thumbnail position', () => {
    it('should seek to 10% of the duration rather than the first frame', async () => {
      const seeded = await seedProcessingVideo(SAMPLE_VIDEO);

      await processor.process(fakeJob(seeded.id));

      const bytes = await storage.getObjectBuffer(
        storage.thumbnailsBucket,
        videoThumbnailKey(seeded.id),
      );
      const path = join(tmpdir(), 'thumb-check.jpg');
      writeFileSync(path, bytes);

      const image = findVideoStream(await probe(path));
      expect(image!.width).toBe(1280);
      expect(image!.height).toBe(720);
    });
  });
});
