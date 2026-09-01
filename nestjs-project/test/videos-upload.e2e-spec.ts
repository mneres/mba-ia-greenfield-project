import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { MailService } from '../src/mail/mail.service';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import {
  VIDEO_PROCESSING_QUEUE,
  VIDEO_PROCESS_JOB,
} from '../src/videos/videos.constants';

const TUS_VERSION = '1.0.0';
const FILENAME = 'Minha Ferias.mp4';
const CONTENT = Buffer.from('fake-video-bytes-for-ingest-testing');

/** `Upload-Metadata` é uma lista de pares `chave <valor em base64>`. */
const encodeMetadata = (pairs: Record<string, string>): string =>
  Object.entries(pairs)
    .map(([key, value]) => `${key} ${Buffer.from(value).toString('base64')}`)
    .join(',');

describe('Videos upload — tus ingest (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let queue: Queue;
  let storage: StorageService;
  let throttlerStorage: ThrottlerStorageService;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    // bodyParser: false é o que main.ts faz — sem isso o corpo do PATCH seria
    // consumido antes de o tus vê-lo.
    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    queue = moduleFixture.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    storage = moduleFixture.get(StorageService);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  }, 60000);

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
    throttlerStorage.storage.clear();
    // Objetos gravados no MinIO sobrevivem ao processo de teste; sem limpar, a
    // asserção "nada foi gravado" enxerga o resíduo da execução anterior.
    await clearVideoObjects();
  });

  async function clearVideoObjects(): Promise<void> {
    const keys = await storage.listObjectKeys(storage.videosBucket, 'videos/');
    for (const key of keys) {
      await storage.deleteObject(storage.videosBucket, key);
    }
  }

  let counter = 0;
  async function authenticate(): Promise<string> {
    counter += 1;
    const email = `uploader-${counter}-${Date.now()}@example.com`;
    const password = 'password123';

    // Mesmo padrão de auth.e2e-spec.ts: intercepta o envio para capturar o
    // token de confirmação sem depender do Mailpit.
    // O MailService vem do container, não de dentro do AuthService: espiar a
    // instância injetada evita furar o encapsulamento só para o teste.
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
      .send({ email, password });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: confirmationToken });
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });

    return (login.body as { access_token: string }).access_token;
  }

  async function createUpload(
    token: string,
    overrides: { uploadLength?: number; filename?: string } = {},
  ) {
    return request(app.getHttpServer())
      .post('/videos/upload')
      .set('Authorization', `Bearer ${token}`)
      .set('Tus-Resumable', TUS_VERSION)
      .set('Upload-Length', String(overrides.uploadLength ?? CONTENT.length))
      .set(
        'Upload-Metadata',
        encodeMetadata({ filename: overrides.filename ?? FILENAME }),
      );
  }

  /** O `Location` é absoluto; o supertest precisa do caminho relativo. */
  const toPath = (location: string): string =>
    new URL(location, 'http://localhost').pathname;

  async function countObjectsUnder(prefix: string): Promise<number> {
    const keys = await storage.listObjectKeys(storage.videosBucket, prefix);
    return keys.length;
  }

  describe('1. Autorização e limites de ingest', () => {
    it('1.1 should reject creation without a token and store nothing', async () => {
      const res = await request(app.getHttpServer())
        .post('/videos/upload')
        .set('Tus-Resumable', TUS_VERSION)
        .set('Upload-Length', String(CONTENT.length))
        .set('Upload-Metadata', encodeMetadata({ filename: FILENAME }));

      expect(res.status).toBe(401);
      expect(await videoRepository.count()).toBe(0);
      expect(await countObjectsUnder('videos/')).toBe(0);
    });

    it('1.2 should reject an Upload-Length above the ceiling with UPLOAD_TOO_LARGE', async () => {
      const token = await authenticate();
      const overLimit = 20 * 1024 * 1024 * 1024;

      const res = await createUpload(token, { uploadLength: overLimit });

      expect(res.status).toBe(413);
      expect(res.body).toMatchObject({
        statusCode: 413,
        error: 'UPLOAD_TOO_LARGE',
      });
      expect(await videoRepository.count()).toBe(0);
      expect(await countObjectsUnder('videos/')).toBe(0);
    });

    it('1.3 should reject with UPLOAD_QUOTA_EXCEEDED once concurrency is exhausted', async () => {
      const token = await authenticate();

      // Semeia o limite de uploads concorrentes criando rascunhos reais.
      const seeded = await Promise.all([
        createUpload(token),
        createUpload(token),
        createUpload(token),
      ]);
      seeded.forEach((res) => expect(res.status).toBe(201));
      const before = await videoRepository.count();

      const res = await createUpload(token);

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        statusCode: 409,
        error: 'UPLOAD_QUOTA_EXCEEDED',
      });
      expect(await videoRepository.count()).toBe(before);
    });
  });

  describe('2. Pré-cadastro e enfileiramento', () => {
    it('2.1 should pre-register a draft row on creation', async () => {
      const token = await authenticate();

      const res = await createUpload(token);

      expect(res.status).toBe(201);
      expect(res.headers.location).toBeDefined();

      const videos = await videoRepository.find();
      expect(videos).toHaveLength(1);
      expect(videos[0].status).toBe(VideoStatus.DRAFT);
      expect(videos[0].title).toBe('Minha Ferias');
      expect(videos[0].public_id).toHaveLength(11);
    });

    it('2.2 should enqueue exactly one job when the upload completes', async () => {
      const token = await authenticate();
      const created = await createUpload(token);

      const patch = await request(app.getHttpServer())
        .patch(toPath(created.headers.location))
        .set('Authorization', `Bearer ${token}`)
        .set('Tus-Resumable', TUS_VERSION)
        .set('Upload-Offset', '0')
        .set('Content-Type', 'application/offset+octet-stream')
        .send(CONTENT);

      expect(patch.status).toBe(204);

      const video = await videoRepository.findOneByOrFail({});
      expect(video.status).toBe(VideoStatus.PROCESSING);
      expect(video.size_bytes).toBe(CONTENT.length);
      expect(video.source_ext).toBe('.mp4');

      const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].name).toBe(VIDEO_PROCESS_JOB);
      expect(jobs[0].data).toEqual({ videoId: video.id });
    });

    it('2.3 should not duplicate the job when the final PATCH is retried', async () => {
      const token = await authenticate();
      const created = await createUpload(token);
      const uploadPath = toPath(created.headers.location);

      const sendFinalPatch = () =>
        request(app.getHttpServer())
          .patch(uploadPath)
          .set('Authorization', `Bearer ${token}`)
          .set('Tus-Resumable', TUS_VERSION)
          .set('Upload-Offset', '0')
          .set('Content-Type', 'application/offset+octet-stream')
          .send(CONTENT);

      await sendFinalPatch();
      await sendFinalPatch();

      const video = await videoRepository.findOneByOrFail({});
      expect(video.status).toBe(VideoStatus.PROCESSING);

      const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
      expect(jobs).toHaveLength(1);
    });
  });
});
