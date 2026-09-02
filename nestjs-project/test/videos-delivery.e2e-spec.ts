import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { Channel } from '../src/channels/entities/channel.entity';
import { MailService } from '../src/mail/mail.service';
import { StorageService } from '../src/storage/storage.service';
import { videoSourceKey } from '../src/storage/storage.keys';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';

/**
 * NOTA sobre o alcance destes testes: TD-01 assina as URLs contra
 * `STORAGE_PUBLIC_ENDPOINT` (`localhost:9000`), que e o host do browser e, por
 * construcao, nao e alcancavel de dentro da rede do Compose. Como SigV4 assina
 * o header Host, nao da para trocar o host da URL pronta sem invalidar a
 * assinatura. Entao os passos dos cenarios que exigiriam *buscar* a URL
 * (Range, Content-Disposition) sao verificados aqui pelos parametros assinados
 * que a URL carrega; o comportamento real ao busca-la e coberto por
 * `src/videos/videos.controller.integration-spec.ts`, que assina contra o
 * endpoint interno justamente para poder fazer o fetch.
 */

const PASSWORD = 'password123';

/** Supertest tipa `body` como `any`; este e o contrato real dos dois endpoints. */
interface DeliveryUrlBody {
  url: string;
  expiresIn: number;
}
const asDelivery = (body: unknown): DeliveryUrlBody => body as DeliveryUrlBody;

describe('Videos delivery (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let storage: StorageService;
  let throttlerStorage: ThrottlerStorageService;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    storage = moduleFixture.get(StorageService);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  }, 60000);

  afterAll(async () => {
    await app.close();
  });

  const seededKeys: string[] = [];

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  afterEach(async () => {
    // Objetos no MinIO sobrevivem ao processo de teste; sem isto eles se
    // acumulam entre execucoes.
    for (const key of seededKeys.splice(0)) {
      await storage.deleteObject(storage.videosBucket, key);
    }
  });

  let counter = 0;
  async function registerAndLogin(): Promise<{
    token: string;
    channelId: string;
  }> {
    counter += 1;
    const email = `viewer-${counter}-${Date.now()}@example.com`;

    const mailService = app.get(MailService);
    let confirmationToken = '';
    jest
      .spyOn(mailService, 'sendConfirmationEmail')
      .mockImplementationOnce((_e: string, _n: string, token: string) => {
        confirmationToken = token;
        return Promise.resolve();
      });

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: PASSWORD });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: confirmationToken });
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: PASSWORD });

    const channel = await dataSource.getRepository(Channel).findOneByOrFail({
      nickname: email.split('@')[0].replace(/[^a-z0-9_]/g, ''),
    });

    return {
      token: (login.body as { access_token: string }).access_token,
      channelId: channel.id,
    };
  }

  let publicIdCounter = 0;
  async function seedVideo(
    channelId: string,
    status: VideoStatus,
    title = 'Minha Ferias',
  ): Promise<Video> {
    publicIdCounter += 1;
    const id = randomUUID();
    const key = videoSourceKey(id, '.mp4');

    await storage.putObject(
      storage.videosBucket,
      key,
      Buffer.from('x'.repeat(300)),
      'video/mp4',
    );
    seededKeys.push(key);

    return videoRepository.save(
      videoRepository.create({
        id,
        public_id: `d${String(publicIdCounter).padStart(10, '0')}`,
        channel_id: channelId,
        title,
        status,
        source_ext: '.mp4',
        upload_id: key,
      }),
    );
  }

  describe('1. Playback', () => {
    it('1.1 should give an anonymous caller a URL for a ready video', async () => {
      const { channelId } = await registerAndLogin();
      const video = await seedVideo(channelId, VideoStatus.READY);

      const res = await request(app.getHttpServer()).get(
        `/videos/${video.public_id}/playback`,
      );

      expect(res.status).toBe(200);
      const body = asDelivery(res.body);
      expect(body.url).toBeTruthy();
      expect(body.expiresIn).toBe(
        Number(process.env.STORAGE_PLAYBACK_URL_TTL_SECONDS ?? 21600),
      );
      expect(body.url.startsWith(process.env.STORAGE_PUBLIC_ENDPOINT!)).toBe(
        true,
      );
    });

    it('1.2 should make a non-ready video indistinguishable from a missing one', async () => {
      const { channelId } = await registerAndLogin();
      const video = await seedVideo(channelId, VideoStatus.PROCESSING);

      const hidden = await request(app.getHttpServer()).get(
        `/videos/${video.public_id}/playback`,
      );
      const missing = await request(app.getHttpServer()).get(
        '/videos/zzzzzzzzzzz/playback',
      );

      expect(hidden.status).toBe(404);
      expect(hidden.body).toMatchObject({
        statusCode: 404,
        error: 'VIDEO_NOT_FOUND',
      });
      // Corpo identico: nada revela que o primeiro video existe.
      expect(hidden.body).toEqual(missing.body);
    });

    it('1.3 should let the owner reach their own non-ready video, but not a stranger', async () => {
      const owner = await registerAndLogin();
      const stranger = await registerAndLogin();
      const video = await seedVideo(owner.channelId, VideoStatus.PROCESSING);

      const asOwner = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/playback`)
        .set('Authorization', `Bearer ${owner.token}`);
      const asStranger = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/playback`)
        .set('Authorization', `Bearer ${stranger.token}`);

      expect(asOwner.status).toBe(200);
      expect(asDelivery(asOwner.body).url).toBeTruthy();

      expect(asStranger.status).toBe(404);
      expect(asStranger.body).toMatchObject({ error: 'VIDEO_NOT_FOUND' });
    });

    it('1.4 should return a URL whose signature covers a TTL long enough for a session', async () => {
      const { channelId } = await registerAndLogin();
      const video = await seedVideo(channelId, VideoStatus.READY);

      const res = await request(app.getHttpServer()).get(
        `/videos/${video.public_id}/playback`,
      );

      // A URL nao e de uso unico nem por-requisicao: o TTL assinado e o que
      // sustenta multiplas requisicoes Range. O comportamento real sob Range
      // e exercitado em videos.controller.integration-spec.ts.
      const body = asDelivery(res.body);
      const url = new URL(body.url);
      expect(Number(url.searchParams.get('X-Amz-Expires'))).toBe(
        body.expiresIn,
      );
      expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
    });
  });

  describe('2. Download', () => {
    it('2.1 should sign an attachment disposition with a readable filename', async () => {
      const { channelId } = await registerAndLogin();
      const video = await seedVideo(
        channelId,
        VideoStatus.READY,
        'Minha Ferias',
      );

      const res = await request(app.getHttpServer()).get(
        `/videos/${video.public_id}/download`,
      );

      expect(res.status).toBe(200);
      const url = new URL(asDelivery(res.body).url);
      const disposition = url.searchParams.get('response-content-disposition');
      expect(disposition).toContain('attachment');
      expect(disposition).toContain('Minha Ferias.mp4');

      // A chave interna nunca aparece no que o cliente le como nome do arquivo.
      expect(disposition).not.toContain('source');
      expect(disposition).not.toContain(video.id);
    });

    it('2.2 should apply the same state gate as playback', async () => {
      const { channelId } = await registerAndLogin();
      const video = await seedVideo(channelId, VideoStatus.FAILED);

      const res = await request(app.getHttpServer()).get(
        `/videos/${video.public_id}/download`,
      );

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: 'VIDEO_NOT_FOUND' });
    });

    it('2.3 should never expose the internal id in either response body', async () => {
      const { channelId } = await registerAndLogin();
      const video = await seedVideo(channelId, VideoStatus.READY);

      const playback = await request(app.getHttpServer()).get(
        `/videos/${video.public_id}/playback`,
      );
      const download = await request(app.getHttpServer()).get(
        `/videos/${video.public_id}/download`,
      );

      // O uuid interno aparece na chave de storage, que vai dentro da URL
      // assinada; o que nao pode e ele figurar como campo da resposta.
      expect(Object.keys(playback.body as object).sort()).toEqual([
        'expiresIn',
        'url',
      ]);
      expect(Object.keys(download.body as object).sort()).toEqual([
        'expiresIn',
        'url',
      ]);
      expect((playback.body as Record<string, unknown>).id).toBeUndefined();
      expect((download.body as Record<string, unknown>).id).toBeUndefined();
    });
  });
});
