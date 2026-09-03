import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import {
  ALL_ENTITIES,
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import * as publicIdUtil from './public-id.util';
import { VideosService } from './videos.service';

describe('VideosService.create (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let service: VideosService;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
    service = new VideosService(videoRepository);
  }, 30000);

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    jest.restoreAllMocks();
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    counter += 1;
    const user = await dataSource.getRepository(User).save({
      email: `video-creator-${counter}@example.com`,
      password: 'hashed',
    });
    return dataSource.getRepository(Channel).save({
      name: `Channel ${counter}`,
      nickname: `creator_${counter}`,
      user_id: user.id,
    });
  }

  it('should persist a draft with a generated public_id', async () => {
    const channel = await createChannel();

    const video = await service.create({
      channel_id: channel.id,
      title: 'Minhas Ferias',
    });

    const stored = await videoRepository.findOneByOrFail({ id: video.id });
    expect(stored.public_id).toHaveLength(11);
    expect(stored.title).toBe('Minhas Ferias');
    expect(stored.channel_id).toBe(channel.id);
  });

  it('should retry with a different public_id when the first one collides', async () => {
    const channel = await createChannel();
    const taken = 'aaaaaaaaaaa';

    await videoRepository.save(
      videoRepository.create({
        public_id: taken,
        channel_id: channel.id,
        title: 'Ja existe',
      }),
    );

    // A primeira tentativa bate na UNIQUE do banco; a segunda cai no gerador real.
    const spy = jest
      .spyOn(publicIdUtil, 'generatePublicId')
      .mockReturnValueOnce(taken);

    const video = await service.create({
      channel_id: channel.id,
      title: 'Segundo',
    });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(video.public_id).not.toBe(taken);

    const stored = await videoRepository.findOneByOrFail({ id: video.id });
    expect(stored.title).toBe('Segundo');
    expect(await videoRepository.count()).toBe(2);
  });

  it('should give up after the retry budget when every id collides', async () => {
    const channel = await createChannel();
    const taken = 'bbbbbbbbbbb';

    await videoRepository.save(
      videoRepository.create({
        public_id: taken,
        channel_id: channel.id,
        title: 'Ja existe',
      }),
    );

    jest.spyOn(publicIdUtil, 'generatePublicId').mockReturnValue(taken);

    await expect(
      service.create({ channel_id: channel.id, title: 'Nunca persiste' }),
    ).rejects.toThrow('Could not generate a unique public_id after 3 attempts');

    expect(await videoRepository.count()).toBe(1);
  });

  it('should surface a non-conflict database error instead of retrying', async () => {
    const spy = jest.spyOn(publicIdUtil, 'generatePublicId');

    // FK inexistente: erro de banco que não é violação de unique.
    await expect(
      service.create({
        channel_id: '00000000-0000-0000-0000-000000000000',
        title: 'Canal fantasma',
      }),
    ).rejects.toThrow();

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('should keep public_id stable when the title changes', async () => {
    const channel = await createChannel();

    const video = await service.create({
      channel_id: channel.id,
      title: 'Titulo original',
    });
    const originalPublicId = video.public_id;

    video.title = 'Titulo editado na Fase 04';
    await videoRepository.save(video);

    const stored = await videoRepository.findOneByOrFail({ id: video.id });
    expect(stored.title).toBe('Titulo editado na Fase 04');
    expect(stored.public_id).toBe(originalPublicId);
  });
});
