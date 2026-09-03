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
import { VIDEO_PROCESSING_QUEUE } from '../src/videos/videos.constants';

/**
 * Prova, com medição em vez de argumento, a propriedade que o enunciado da fase
 * cobra: um upload grande **não trava a API**.
 *
 * O ingest tus é montado como rota de controller, então os bytes atravessam o
 * processo da API (per `phase-03-videos/TD-03`). O que torna isso seguro não é
 * o caminho dos bytes, e sim o fato de eles nunca serem materializados: o
 * `@tus/s3-store` traduz o stream de chunks num multipart upload do S3. Este
 * arquivo verifica exatamente essa distinção.
 *
 * O app roda no mesmo processo do teste, via supertest — o que dá valor à
 * medição de latência, porque um ingest que bloqueasse o event loop apareceria
 * imediatamente nas sondas concorrentes.
 *
 * **Por que não há asserção de memória aqui.** Seria o instinto natural, mas
 * neste harness ela não discrimina: app e teste dividem o processo, então o RSS
 * inclui as cópias que o próprio supertest faz do corpo — medido, o pico chega a
 * +70MB para um payload de 24MB. E o delta de heap ao final é dominado pelo GC,
 * a ponto de ficar negativo. O que prova ausência de buffering é o offset
 * persistido no meio do envio: o `HEAD` do tus lê o datastore, então um servidor
 * que acumulasse o arquivo responderia 0 ali.
 *
 * O que este teste **não** cobre: o comportamento em 10GB reais, e o
 * particionamento do multipart em partes de 50MB — o payload aqui cabe numa
 * parte só. A aritmética das partes está no TD-03.
 */

const TUS_VERSION = '1.0.0';

/** 24 MB em 8 PATCHes de 3 MB. Grande o bastante para o buffering aparecer. */
const CHUNK_BYTES = 3 * 1024 * 1024;
const CHUNK_COUNT = 8;
const TOTAL_BYTES = CHUNK_BYTES * CHUNK_COUNT;

/** Intervalo entre sondas ao endpoint de saúde durante o upload. */
const PROBE_INTERVAL_MS = 25;

/**
 * Teto generoso de propósito: só falha se houver bloqueio real do event loop.
 * Um limite apertado transformaria variação de máquina em falha de teste.
 */
const MAX_PROBE_LATENCY_MS = 2000;

const encodeMetadata = (pairs: Record<string, string>): string =>
  Object.entries(pairs)
    .map(([key, value]) => `${key} ${Buffer.from(value).toString('base64')}`)
    .join(',');

interface ProbeResult {
  statuses: number[];
  maxLatencyMs: number;
}

describe('Videos upload — throughput and responsiveness (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let storage: StorageService;
  let queue: Queue;
  let throttlerStorage: ThrottlerStorageService;
  let token: string;

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
    queue = moduleFixture.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);

    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    token = await registerAndLogin();
  }, 120000);

  afterAll(async () => {
    for (const key of await storage.listObjectKeys(
      storage.videosBucket,
      'videos/',
    )) {
      await storage.deleteObject(storage.videosBucket, key);
    }
    await queue.obliterate({ force: true });
    await app.close();
  }, 60000);

  async function registerAndLogin(): Promise<string> {
    const email = `throughput-${Date.now()}@example.com`;
    const password = 'password123';

    const mailService = app.get(MailService);
    let confirmationToken = '';
    jest
      .spyOn(mailService, 'sendConfirmationEmail')
      .mockImplementationOnce((_e: string, _n: string, t: string) => {
        confirmationToken = t;
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

  /** Bate no endpoint de saúde até `stop` virar true, registrando latências. */
  async function probeWhile(stop: () => boolean): Promise<ProbeResult> {
    const statuses: number[] = [];
    let maxLatencyMs = 0;

    while (!stop()) {
      const started = Date.now();
      const res = await request(app.getHttpServer()).get('/');
      maxLatencyMs = Math.max(maxLatencyMs, Date.now() - started);
      statuses.push(res.status);
      await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
    }

    return { statuses, maxLatencyMs };
  }

  it('should keep serving other requests while a large upload streams through', async () => {
    const created = await request(app.getHttpServer())
      .post('/videos/upload')
      .set('Authorization', `Bearer ${token}`)
      .set('Tus-Resumable', TUS_VERSION)
      .set('Upload-Length', String(TOTAL_BYTES))
      .set('Upload-Metadata', encodeMetadata({ filename: 'grande.mp4' }));

    expect(created.status).toBe(201);
    const uploadPath = new URL(created.headers.location, 'http://localhost')
      .pathname;

    const chunk = Buffer.alloc(CHUNK_BYTES, 0x61);
    const offsetsSeen: number[] = [];
    let midUploadPersistedOffset = -1;
    let uploadDone = false;

    const upload = (async () => {
      for (let i = 0; i < CHUNK_COUNT; i++) {
        const patch = await request(app.getHttpServer())
          .patch(uploadPath)
          .set('Authorization', `Bearer ${token}`)
          .set('Tus-Resumable', TUS_VERSION)
          .set('Upload-Offset', String(i * CHUNK_BYTES))
          .set('Content-Type', 'application/offset+octet-stream')
          .send(chunk);

        expect(patch.status).toBe(204);
        offsetsSeen.push(Number(patch.headers['upload-offset']));

        // Na metade do envio, pergunta ao servidor onde ele acha que está. O
        // HEAD do tus lê o offset **persistido no datastore**, não um contador
        // em memória: se a resposta reflete os bytes já enviados, eles saíram
        // do processo antes do upload terminar.
        if (i === CHUNK_COUNT / 2 - 1) {
          const head = await request(app.getHttpServer())
            .head(uploadPath)
            .set('Authorization', `Bearer ${token}`)
            .set('Tus-Resumable', TUS_VERSION);

          expect(head.status).toBe(200);
          midUploadPersistedOffset = Number(head.headers['upload-offset']);
        }
      }
      uploadDone = true;
    })();

    const [, probes] = await Promise.all([
      upload,
      probeWhile(() => uploadDone),
    ]);

    // A evidência é o produto deste teste, então fica visível na saída.
    console.log(
      `[medição] payload=${TOTAL_BYTES / 1024 / 1024}MB ` +
        `sondas=${probes.statuses.length} ` +
        `latênciaMáx=${probes.maxLatencyMs}ms ` +
        `offsetPersistidoNaMetade=${midUploadPersistedOffset / 1024 / 1024}MB`,
    );

    // 1. A API seguiu respondendo durante todo o envio.
    expect(probes.statuses.length).toBeGreaterThan(3);
    expect(probes.statuses.every((status) => status === 200)).toBe(true);
    expect(probes.maxLatencyMs).toBeLessThan(MAX_PROBE_LATENCY_MS);

    // 2. Os bytes foram comprometidos ao storage à medida que chegaram, e não
    //    acumulados até o fim: o offset avança a cada PATCH.
    expect(offsetsSeen).toEqual(
      Array.from({ length: CHUNK_COUNT }, (_, i) => (i + 1) * CHUNK_BYTES),
    );

    // 3. E já estavam persistidos na metade do caminho: uma implementação que
    //    acumulasse o arquivo para só então gravá-lo reportaria offset 0 aqui.
    expect(midUploadPersistedOffset).toBe((CHUNK_COUNT / 2) * CHUNK_BYTES);

    // 4. E o resultado final continua correto.
    const video = await videoRepository.findOneByOrFail({});
    expect(video.status).toBe(VideoStatus.PROCESSING);
    expect(video.size_bytes).toBe(TOTAL_BYTES);
  }, 180000);
});
