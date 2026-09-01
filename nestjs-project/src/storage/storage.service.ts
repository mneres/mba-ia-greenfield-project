import {
  ListObjectsV2Command,
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Readable } from 'stream';
import storageConfig from '../config/storage.config';

/** Política que libera leitura anônima de um bucket inteiro. */
const publicReadPolicy = (bucket: string): string =>
  JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { AWS: ['*'] },
        Action: ['s3:GetObject'],
        Resource: [`arn:aws:s3:::${bucket}/*`],
      },
    ],
  });

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);

  /**
   * Cliente interno — resolve o storage pelo nome de serviço do Compose. Usado
   * em toda operação server-side (put, get, delete, criação de bucket).
   */
  private readonly client: S3Client;

  /**
   * Cliente de assinatura — aponta para o host público. A assinatura SigV4
   * cobre o header `Host`, então uma URL assinada pelo cliente interno é
   * inválida quando o browser a resolve (per `phase-03-videos/TD-01`).
   */
  private readonly presignClient: S3Client;

  readonly videosBucket: string;
  readonly thumbnailsBucket: string;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    const { accessKey, secretKey } = config;
    if (!accessKey || !secretKey) {
      throw new Error(
        'STORAGE_ACCESS_KEY and STORAGE_SECRET_KEY must be defined',
      );
    }

    const credentials = { accessKeyId: accessKey, secretAccessKey: secretKey };
    // `forcePathStyle` é obrigatório para MinIO: o endpoint custom não tem DNS
    // wildcard para subdomínios por bucket, então o estilo virtual-host falha.
    const common = {
      region: config.region,
      forcePathStyle: true,
      credentials,
    };

    this.client = new S3Client({ ...common, endpoint: config.endpoint });
    this.presignClient = new S3Client({
      ...common,
      endpoint: config.publicEndpoint,
    });

    this.videosBucket = config.videosBucket;
    this.thumbnailsBucket = config.thumbnailsBucket;
  }

  /**
   * Garante os dois buckets no boot. Idempotente: subir a aplicação duas vezes
   * não falha por bucket já existente (per `phase-03-videos/TD-02`).
   */
  async onModuleInit(): Promise<void> {
    await this.ensureBucket(this.videosBucket, false);
    await this.ensureBucket(this.thumbnailsBucket, true);
  }

  async ensureBucket(bucket: string, publicRead: boolean): Promise<void> {
    if (!(await this.bucketExists(bucket))) {
      await this.client.send(new CreateBucketCommand({ Bucket: bucket }));
      this.logger.log(`Created bucket ${bucket}`);
    }

    if (publicRead) {
      await this.client.send(
        new PutBucketPolicyCommand({
          Bucket: bucket,
          Policy: publicReadPolicy(bucket),
        }),
      );
    }
  }

  private async bucketExists(bucket: string): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: bucket }));
      return true;
    } catch {
      return false;
    }
  }

  async putObject(
    bucket: string,
    key: string,
    body: Buffer | Readable,
    contentType?: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async getObjectBuffer(bucket: string, key: string): Promise<Buffer> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    const bytes = await result.Body!.transformToByteArray();
    return Buffer.from(bytes);
  }

  /** Chaves sob um prefixo. Usado por testes para provar ausência de escrita. */
  async listObjectKeys(bucket: string, prefix: string): Promise<string[]> {
    const result = await this.client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }),
    );
    return (result.Contents ?? [])
      .map((object) => object.Key)
      .filter((key): key is string => key !== undefined);
  }

  async deleteObject(bucket: string, key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: bucket, Key: key }),
    );
  }

  /**
   * URL presignada de leitura, assinada contra o host público.
   *
   * `expiresIn` é sempre explícito — o default da lib é 900s, que expiraria no
   * meio de uma sessão de playback (per `phase-03-videos/TD-12`).
   *
   * `contentDisposition`, quando informado, vira o query param assinado
   * `response-content-disposition`; a AWS exige requisição assinada para
   * overrides de header (per `phase-03-videos/TD-13`).
   */
  async presignGet(
    bucket: string,
    key: string,
    expiresInSeconds: number,
    contentDisposition?: string,
  ): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ResponseContentDisposition: contentDisposition,
    });
    return getSignedUrl(this.presignClient, command, {
      expiresIn: expiresInSeconds,
    });
  }
}
