import { randomUUID } from 'crypto';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { videoSourceKey } from '../storage/storage.keys';
import { buildDownloadFilename } from './delivery-filename.util';

/**
 * Prova que as URLs presignadas funcionam de fato contra o MinIO — o que um
 * teste com o presigner mockado nunca mostraria, porque uma assinatura errada
 * so falha quando o storage a valida.
 *
 * **Duas instancias, de proposito.** TD-01 assina contra
 * `STORAGE_PUBLIC_ENDPOINT` (`localhost:9000`), que e o host do browser e por
 * construcao *nao* e alcancavel de dentro da rede do Compose — dali `localhost`
 * e o proprio container. Como SigV4 assina o header Host, trocar o host da URL
 * pronta invalidaria a assinatura. Entao: `storage` prova a escolha de
 * endpoint, e `reachableStorage`, assinando contra o endpoint interno, prova o
 * mecanismo (Range, Content-Disposition) buscando os bytes de verdade.
 */
describe('Delivery presigning (integration)', () => {
  let storage: StorageService;
  let reachableStorage: StorageService;
  let key: string;

  const TTL_SECONDS = 3600;
  const CONTENT = Buffer.from('a'.repeat(500));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    await moduleRef.init();
    storage = moduleRef.get(StorageService);

    const realConfig = storageConfig();
    const reachableRef = await Test.createTestingModule({
      providers: [
        StorageService,
        {
          provide: storageConfig.KEY,
          useValue: { ...realConfig, publicEndpoint: realConfig.endpoint },
        },
      ],
    }).compile();
    reachableStorage = reachableRef.get(StorageService);

    key = videoSourceKey(randomUUID(), '.mp4');
    await storage.putObject(storage.videosBucket, key, CONTENT, 'video/mp4');
  }, 30000);

  afterAll(async () => {
    await storage.deleteObject(storage.videosBucket, key);
  });

  describe('endpoint choice', () => {
    it('should sign against the public endpoint, not the compose-internal one', async () => {
      const url = await storage.presignGet(
        storage.videosBucket,
        key,
        TTL_SECONDS,
      );

      expect(url.startsWith(process.env.STORAGE_PUBLIC_ENDPOINT!)).toBe(true);
      expect(url).not.toContain('minio:9000');
    });
  });

  describe('playback URL', () => {
    it('should resolve against the storage and return the bytes', async () => {
      const url = await reachableStorage.presignGet(
        reachableStorage.videosBucket,
        key,
        TTL_SECONDS,
      );

      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect((await response.arrayBuffer()).byteLength).toBe(CONTENT.length);
    });

    it('should stay valid across repeated Range requests inside the TTL', async () => {
      const url = await reachableStorage.presignGet(
        reachableStorage.videosBucket,
        key,
        TTL_SECONDS,
      );

      const first = await fetch(url, { headers: { Range: 'bytes=0-99' } });
      expect(first.status).toBe(206);
      expect(first.headers.get('content-range')).toBeTruthy();

      // A mesma assinatura, de novo: uma URL presignada nao e de uso unico.
      const second = await fetch(url, { headers: { Range: 'bytes=100-199' } });
      expect(second.status).toBe(206);
      expect((await second.arrayBuffer()).byteLength).toBe(100);
    });

    it('should reject a tampered signature', async () => {
      const url = await reachableStorage.presignGet(
        reachableStorage.videosBucket,
        key,
        TTL_SECONDS,
      );
      const tampered = url.replace(
        /X-Amz-Signature=([0-9a-f]{8})/,
        (_match, prefix: string) =>
          `X-Amz-Signature=${prefix.split('').reverse().join('')}`,
      );

      const response = await fetch(tampered);
      expect(response.status).toBe(403);
    });
  });

  describe('download URL', () => {
    it('should force attachment with a filename derived from the title', async () => {
      const filename = buildDownloadFilename('Minha Ferias', '.mp4');
      const url = await reachableStorage.presignGet(
        reachableStorage.videosBucket,
        key,
        TTL_SECONDS,
        `attachment; filename="${filename}"`,
      );

      const response = await fetch(url);

      expect(response.status).toBe(200);
      const disposition = response.headers.get('content-disposition');
      expect(disposition).toContain('attachment');
      expect(disposition).toContain('Minha Ferias.mp4');
    });

    it('should not leak the storage key through the response headers', async () => {
      const filename = buildDownloadFilename('Minha Ferias', '.mp4');
      const url = await reachableStorage.presignGet(
        reachableStorage.videosBucket,
        key,
        TTL_SECONDS,
        `attachment; filename="${filename}"`,
      );

      const response = await fetch(url);

      // O nome entregue ao usuario vem do titulo; a chave real
      // (`videos/{uuid}/source.mp4`) nao aparece no header.
      expect(response.headers.get('content-disposition')).not.toContain(
        'source',
      );
    });
  });
});
