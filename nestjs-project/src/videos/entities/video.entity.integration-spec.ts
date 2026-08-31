import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  }, 30000);

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    counter += 1;
    const user = await userRepository.save(
      userRepository.create({
        email: `video-owner-${counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `channel_${counter}`,
        user_id: user.id,
      }),
    );
  }

  describe('defaults', () => {
    it('should default status to draft and leave processing_error null', async () => {
      const channel = await createChannel();

      const video = await videoRepository.save(
        videoRepository.create({
          public_id: 'aaaaaaaaaaa',
          channel_id: channel.id,
          title: 'Minha Ferias',
        }),
      );
      const stored = await videoRepository.findOneByOrFail({ id: video.id });

      expect(stored.status).toBe(VideoStatus.DRAFT);
      expect(stored.processing_error).toBeNull();
    });

    it('should leave every metadata column null before processing', async () => {
      const channel = await createChannel();

      const video = await videoRepository.save(
        videoRepository.create({
          public_id: 'bbbbbbbbbbb',
          channel_id: channel.id,
          title: 'Sem metadados',
        }),
      );
      const stored = await videoRepository.findOneByOrFail({ id: video.id });

      expect(stored.duration).toBeNull();
      expect(stored.width).toBeNull();
      expect(stored.height).toBeNull();
      expect(stored.ffprobe_metadata).toBeNull();
      expect(stored.size_bytes).toBeNull();
      expect(stored.source_ext).toBeNull();
      expect(stored.upload_id).toBeNull();
    });
  });

  describe('constraints', () => {
    it('should reject two videos sharing the same public_id', async () => {
      const channel = await createChannel();
      await videoRepository.save(
        videoRepository.create({
          public_id: 'ccccccccccc',
          channel_id: channel.id,
          title: 'Primeiro',
        }),
      );

      await expect(
        videoRepository.save(
          videoRepository.create({
            public_id: 'ccccccccccc',
            channel_id: channel.id,
            title: 'Segundo',
          }),
        ),
      ).rejects.toThrow(QueryFailedError);
    });

    it('should reject a video whose channel does not exist', async () => {
      await expect(
        videoRepository.save(
          videoRepository.create({
            public_id: 'ddddddddddd',
            channel_id: '00000000-0000-0000-0000-000000000000',
            title: 'Canal fantasma',
          }),
        ),
      ).rejects.toThrow(QueryFailedError);
    });
  });

  describe('column types', () => {
    it('should round-trip numeric duration and bigint size as numbers', async () => {
      const channel = await createChannel();

      const video = await videoRepository.save(
        videoRepository.create({
          public_id: 'eeeeeeeeeee',
          channel_id: channel.id,
          title: 'Com metadados',
          duration: 132.48,
          width: 1920,
          height: 1080,
          size_bytes: 10737418240,
        }),
      );
      const stored = await videoRepository.findOneByOrFail({ id: video.id });

      expect(typeof stored.duration).toBe('number');
      expect(stored.duration).toBeCloseTo(132.48, 2);
      expect(typeof stored.size_bytes).toBe('number');
      expect(stored.size_bytes).toBe(10737418240);
      expect(stored.width).toBe(1920);
    });

    it('should round-trip the full ffprobe payload through jsonb', async () => {
      const channel = await createChannel();
      const payload = {
        format: { duration: '132.48', format_name: 'mov,mp4' },
        streams: [{ codec_type: 'video', codec_name: 'h264' }],
      };

      const video = await videoRepository.save(
        videoRepository.create({
          public_id: 'fffffffffff',
          channel_id: channel.id,
          title: 'Com ffprobe',
          ffprobe_metadata: payload,
        }),
      );
      const stored = await videoRepository.findOneByOrFail({ id: video.id });

      expect(stored.ffprobe_metadata).toEqual(payload);
    });

    it('should accept every value of the status enum', async () => {
      const channel = await createChannel();
      const statuses = Object.values(VideoStatus);

      for (const [i, status] of statuses.entries()) {
        const video = await videoRepository.save(
          videoRepository.create({
            public_id: `status-${i}`.padEnd(11, '0').slice(0, 11),
            channel_id: channel.id,
            title: `Status ${status}`,
            status,
          }),
        );
        expect(video.status).toBe(status);
      }
    });
  });

  describe('schema scope', () => {
    it('should not expose a visibility column in this phase', async () => {
      const columns = await dataSource.query<{ column_name: string }[]>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'videos'`,
      );
      const names = columns.map((c) => c.column_name);

      expect(names).not.toContain('visibility');
    });

    it('should not carry a visibility value in the status enum', async () => {
      const values = await dataSource.query<{ enumlabel: string }[]>(
        `SELECT e.enumlabel FROM pg_enum e
         JOIN pg_type t ON t.oid = e.enumtypid
         WHERE t.typname = 'videos_status_enum'`,
      );
      const labels = values.map((v) => v.enumlabel);

      expect(labels.sort()).toEqual([
        'draft',
        'failed',
        'processing',
        'ready',
        'uploading',
      ]);
    });
  });
});
