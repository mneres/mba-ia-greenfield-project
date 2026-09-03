import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { UploadQuotaExceededException } from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import { Channel } from '../channels/entities/channel.entity';
import {
  ALL_ENTITIES,
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { UploadQuotaService } from './upload-quota.service';

const MAX_CONCURRENT = 3;
const MAX_TOTAL_BYTES = 10_000;

/**
 * Contraparte de integração do `upload-quota.service.spec.ts`.
 *
 * O teste unitário mocka o repositório, então ele prova a lógica de limite mas
 * nada sobre as queries. Aqui elas rodam de verdade: o COUNT filtrado por
 * status e o SUM com COALESCE sobre `bigint` — que volta como string no driver
 * pg e viraria `NaN` numa comparação ingênua.
 */
describe('Upload ingest quota (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let service: UploadQuotaService;
  let channelId: string;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
      ],
      providers: [
        UploadQuotaService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        {
          provide: storageConfig.KEY,
          useValue: {
            maxConcurrentUploadsPerUser: MAX_CONCURRENT,
            maxTotalBytesPerUser: MAX_TOTAL_BYTES,
          },
        },
      ],
    }).compile();

    service = moduleRef.get(UploadQuotaService);
  }, 30000);

  afterAll(async () => {
    await dataSource.destroy();
  });

  let counter = 0;
  beforeEach(async () => {
    await cleanAllTables(dataSource);
    counter += 1;

    const user = await dataSource.getRepository(User).save({
      email: `quota-${counter}@example.com`,
      password: 'hashed',
    });
    const channel = await dataSource.getRepository(Channel).save({
      name: `Channel ${counter}`,
      nickname: `quota_${counter}`,
      user_id: user.id,
    });
    channelId = channel.id;
  });

  let publicIdCounter = 0;
  async function seedVideo(
    status: VideoStatus,
    sizeBytes: number | null = null,
  ): Promise<Video> {
    publicIdCounter += 1;
    return videoRepository.save(
      videoRepository.create({
        public_id: `q${String(publicIdCounter).padStart(10, '0')}`,
        channel_id: channelId,
        title: `Seed ${publicIdCounter}`,
        status,
        size_bytes: sizeBytes,
      }),
    );
  }

  describe('concurrency query', () => {
    it('should pass on an empty channel', async () => {
      await expect(
        service.assertWithinQuota(channelId),
      ).resolves.toBeUndefined();
    });

    it('should count both draft and uploading toward the limit', async () => {
      await seedVideo(VideoStatus.DRAFT);
      await seedVideo(VideoStatus.UPLOADING);
      await seedVideo(VideoStatus.DRAFT);

      await expect(service.assertWithinQuota(channelId)).rejects.toThrow(
        UploadQuotaExceededException,
      );
    });

    it('should not count finished videos toward concurrency', async () => {
      // ready/failed/processing não ocupam slot: o upload já terminou.
      await seedVideo(VideoStatus.READY);
      await seedVideo(VideoStatus.FAILED);
      await seedVideo(VideoStatus.PROCESSING);
      await seedVideo(VideoStatus.DRAFT);

      await expect(
        service.assertWithinQuota(channelId),
      ).resolves.toBeUndefined();
    });

    it('should not count another channel toward this one', async () => {
      const otherUser = await dataSource.getRepository(User).save({
        email: `other-${counter}@example.com`,
        password: 'hashed',
      });
      const otherChannel = await dataSource.getRepository(Channel).save({
        name: 'Other',
        nickname: `other_${counter}`,
        user_id: otherUser.id,
      });
      for (let i = 0; i < MAX_CONCURRENT; i++) {
        publicIdCounter += 1;
        await videoRepository.save(
          videoRepository.create({
            public_id: `o${String(publicIdCounter).padStart(10, '0')}`,
            channel_id: otherChannel.id,
            title: 'Other channel',
            status: VideoStatus.DRAFT,
          }),
        );
      }

      await expect(
        service.assertWithinQuota(channelId),
      ).resolves.toBeUndefined();
    });
  });

  describe('aggregate storage query', () => {
    it('should sum bigint sizes across the channel', async () => {
      await seedVideo(VideoStatus.READY, MAX_TOTAL_BYTES / 2);
      await seedVideo(VideoStatus.READY, MAX_TOTAL_BYTES / 2);

      await expect(service.assertWithinQuota(channelId)).rejects.toThrow(
        UploadQuotaExceededException,
      );
    });

    it('should ignore null sizes rather than poisoning the sum', async () => {
      await seedVideo(VideoStatus.READY, null);
      await seedVideo(VideoStatus.READY, 1);

      await expect(
        service.assertWithinQuota(channelId),
      ).resolves.toBeUndefined();
    });

    it('should report the stored total in the rejection message', async () => {
      await seedVideo(VideoStatus.READY, MAX_TOTAL_BYTES);

      await expect(service.assertWithinQuota(channelId)).rejects.toThrow(
        `Channel already stores ${MAX_TOTAL_BYTES} bytes`,
      );
    });
  });
});
