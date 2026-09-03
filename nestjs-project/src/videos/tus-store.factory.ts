import type { ConfigType } from '@nestjs/config';
import { S3Store } from '@tus/s3-store';
import storageConfig from '../config/storage.config';
import {
  TUS_MAX_MULTIPART_PARTS,
  TUS_PART_SIZE_BYTES,
} from './videos.constants';

/**
 * Constroi o datastore tus a partir da config.
 *
 * Fonte unica de proposito: a API monta o `Server` como rota e o worker monta
 * outro so para chamar `cleanUpExpiredUploads()` (per `TD-17` Revision). Se as
 * duas construcoes divergissem no `expirationPeriodInMilliseconds` ou no
 * `useTags`, o reaper deixaria de reconhecer como expirado exatamente o que a
 * API marcou — e a falha seria silenciosa.
 */
export function createTusS3Store(
  config: ConfigType<typeof storageConfig>,
): S3Store {
  if (!config.accessKey || !config.secretKey) {
    throw new Error(
      'STORAGE_ACCESS_KEY and STORAGE_SECRET_KEY must be defined',
    );
  }

  return new S3Store({
    partSize: TUS_PART_SIZE_BYTES,
    maxMultipartParts: TUS_MAX_MULTIPART_PARTS,
    // Habilita a extensao de expiracao: passado o prazo, a URL do upload
    // responde 410 Gone, que e o sinal para o cliente reiniciar em vez de
    // falhar em silencio (per `phase-03-videos/TD-17`).
    expirationPeriodInMilliseconds:
      config.uploadExpirationHours * 60 * 60 * 1000,
    // A extensao de expiracao e implementada com object tagging. MinIO
    // suporta; num backend sem tagging isto desliga a expiracao calado.
    useTags: true,
    s3ClientConfig: {
      bucket: config.videosBucket,
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
    },
  });
}
