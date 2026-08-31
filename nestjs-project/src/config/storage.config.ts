import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  // Endpoint interno — resolvido pelo nome de serviço do Compose. Usado nas
  // operações server-side do SDK.
  endpoint: process.env.STORAGE_ENDPOINT || 'http://minio:9000',
  // Endpoint público — usado APENAS ao assinar URLs entregues ao browser. A
  // assinatura SigV4 cobre o header Host, então uma URL assinada contra o
  // endpoint interno é inválida fora da rede do Compose.
  publicEndpoint: process.env.STORAGE_PUBLIC_ENDPOINT || 'http://localhost:9000',
  region: process.env.STORAGE_REGION || 'us-east-1',
  accessKey: process.env.STORAGE_ACCESS_KEY,
  secretKey: process.env.STORAGE_SECRET_KEY,
  videosBucket: process.env.STORAGE_VIDEOS_BUCKET || 'streamtube-videos',
  thumbnailsBucket:
    process.env.STORAGE_THUMBNAILS_BUCKET || 'streamtube-thumbnails',
  maxUploadBytes: parseInt(
    process.env.STORAGE_MAX_UPLOAD_BYTES || '10737418240',
    10,
  ),
  playbackUrlTtlSeconds: parseInt(
    process.env.STORAGE_PLAYBACK_URL_TTL_SECONDS || '21600',
    10,
  ),
  uploadExpirationHours: parseInt(
    process.env.UPLOAD_EXPIRATION_HOURS || '48',
    10,
  ),
  maxConcurrentUploadsPerUser: parseInt(
    process.env.UPLOAD_MAX_CONCURRENT_PER_USER || '3',
    10,
  ),
  maxTotalBytesPerUser: parseInt(
    process.env.UPLOAD_MAX_TOTAL_BYTES_PER_USER || '53687091200',
    10,
  ),
}));
