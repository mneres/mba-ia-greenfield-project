import { randomUUID } from 'crypto';
import { extname } from 'path';
import type http from 'http';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { EVENTS, Server, type Upload } from '@tus/server';
import { ChannelsService } from '../channels/channels.service';
import {
  DomainException,
  UploadTooLargeException,
} from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import {
  parseVideoIdFromSourceKey,
  videoSourceKey,
} from '../storage/storage.keys';
import type { JwtPayload } from '../auth/auth.types';
import { createTusS3Store } from './tus-store.factory';
import { UploadQuotaService } from './upload-quota.service';
import { VideoQueueService } from './video-queue.service';
import { VideoStatus } from './entities/video.entity';
import { TUS_UPLOAD_PATH } from './videos.constants';
import { VideosService } from './videos.service';

/** O `JwtAuthGuard` grava o payload na request antes de o tus vê-la. */
type AuthenticatedRequest = http.IncomingMessage & { user?: JwtPayload };

const DEFAULT_TITLE = 'Untitled';

@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);
  private readonly server: Server;

  constructor(
    private readonly videosService: VideosService,
    private readonly quotaService: UploadQuotaService,
    private readonly queueService: VideoQueueService,
    private readonly channelsService: ChannelsService,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.server = new Server({
      path: TUS_UPLOAD_PATH,
      datastore: createTusS3Store(this.config),
      // Defesa em profundidade: o teto também é checado explicitamente em
      // `onUploadCreate`, que é onde o erro vira o envelope do projeto.
      maxSize: this.config.maxUploadBytes,
      namingFunction: (_req, metadata) => this.buildStorageKey(metadata),
      getFileIdFromRequest: (req) => this.extractUploadId(req),
      onUploadCreate: (req, res, upload) =>
        this.onUploadCreate(req, res, upload),
      onUploadFinish: (_req, res, upload) => this.onUploadFinish(res, upload),
      onResponseError: (_req, res, err) => this.onResponseError(res, err),
    });

    this.registerProgressListener();
  }

  /**
   * Registrado no construtor: o tus emite este evento enquanto os bytes chegam,
   * que é o momento em que TD-05 define o vídeo como `uploading`. Sem ele o
   * estado só seria observável depois do upload inteiro, o que o tornaria
   * inútil para o painel da Fase 04 e para o reaper de TD-17.
   */
  private registerProgressListener(): void {
    this.server.on(EVENTS.POST_RECEIVE, (_req, _res, upload: Upload) => {
      const videoId = parseVideoIdFromSourceKey(upload.id);
      if (!videoId) return;
      // Fire-and-forget: progresso não pode derrubar a resposta do upload.
      void this.videosService
        .markUploading(videoId)
        .catch((err: Error) =>
          this.logger.warn(
            `Could not mark ${videoId} as uploading: ${err.message}`,
          ),
        );
    });
  }

  handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<unknown> {
    // Sem try/catch: o servidor tus é dono do próprio ciclo de resposta, e
    // capturar depois significaria que a resposta já foi enviada
    // (per `phase-03-videos/TD-04` Revision).
    return this.server.handle(req, res);
  }

  /**
   * O id do upload é a própria chave de storage.
   *
   * TD-02 exige `videos/{videoId}/source{ext}`, mas o nome é escolhido antes de
   * a row existir — então o `videoId` é sorteado aqui e reusado como PK em
   * `onUploadCreate`. É o que mantém a chave determinística e, com isso, um job
   * reexecutado sobrescrevendo em vez de duplicar (per `phase-03-videos/TD-11`).
   */
  private buildStorageKey(metadata?: Record<string, string | null>): string {
    return videoSourceKey(randomUUID(), this.extractExtension(metadata));
  }

  /**
   * O id contém barras, então o último segmento da URL não basta: o que vale é
   * tudo depois do prefixo de montagem.
   */
  private extractUploadId(req: http.IncomingMessage): string | undefined {
    const path = new URL(req.url ?? '', 'http://placeholder').pathname;
    const prefix = `${TUS_UPLOAD_PATH}/`;
    if (!path.startsWith(prefix)) return undefined;
    return decodeURIComponent(path.slice(prefix.length)) || undefined;
  }

  private extractExtension(metadata?: Record<string, string | null>): string {
    const filename = metadata?.filename;
    if (!filename) return '';
    // Extensão é dica do cliente, não fonte de verdade: o `ffprobe` do worker é
    // que decide se há stream de vídeo (per `phase-03-videos/TD-04`).
    return extname(filename).slice(0, 16);
  }

  private extractTitle(metadata?: Record<string, string | null>): string {
    const filename = metadata?.filename;
    if (!filename) return DEFAULT_TITLE;
    const withoutExtension = filename.slice(
      0,
      filename.length - extname(filename).length,
    );
    return withoutExtension.trim().slice(0, 255) || DEFAULT_TITLE;
  }

  /**
   * Toda a defesa acontece aqui, que é o único ponto em que as checagens rodam
   * antes de qualquer byte ser gravado (per `phase-03-videos/TD-04`).
   */
  private async onUploadCreate(
    req: AuthenticatedRequest,
    res: http.ServerResponse,
    upload: Upload,
  ): Promise<{
    res: http.ServerResponse;
    metadata?: Record<string, string | null>;
  }> {
    const user = req.user;
    if (!user) {
      // Só acontece se a rota for montada fora do pipeline de guards.
      throw new Error('Upload reached tus without an authenticated user');
    }

    const declaredSize = upload.size ?? 0;
    if (declaredSize > this.config.maxUploadBytes) {
      throw new UploadTooLargeException(this.config.maxUploadBytes);
    }

    const channel = await this.channelsService.findByUserId(user.sub);
    if (!channel) {
      throw new Error(`Authenticated user ${user.sub} has no channel`);
    }

    await this.quotaService.assertWithinQuota(channel.id);

    const videoId = parseVideoIdFromSourceKey(upload.id);
    if (!videoId) {
      throw new Error(`Upload id is not a valid source key: ${upload.id}`);
    }

    await this.videosService.create({
      id: videoId,
      channel_id: channel.id,
      title: this.extractTitle(upload.metadata),
      upload_id: upload.id,
    });

    return { res, metadata: upload.metadata };
  }

  /**
   * Último PATCH concluído: o objeto já está inteiro no bucket privado.
   */
  private async onUploadFinish(
    res: http.ServerResponse,
    upload: Upload,
  ): Promise<{ res: http.ServerResponse }> {
    const videoId = parseVideoIdFromSourceKey(upload.id);
    if (!videoId) return { res };

    const video = await this.videosService.findById(videoId);
    if (!video) return { res };

    // Reenvio do PATCH final é comportamento normal de cliente tus. A row já
    // estar em `processing` significa que este hook já rodou — sair aqui evita
    // uma transição inválida, e a deduplicação da fila cobre o job.
    if (video.status === VideoStatus.PROCESSING) return { res };

    // O evento de progresso normalmente já moveu para `uploading`; num upload
    // de uma parte só ele pode não ter chegado a rodar, e `draft -> processing`
    // não existe na máquina de estados do TD-05.
    if (video.status === VideoStatus.DRAFT) {
      await this.videosService.markUploading(video.id);
      video.status = VideoStatus.UPLOADING;
    }

    video.size_bytes = upload.size ?? null;
    video.source_ext = extname(upload.id).slice(0, 16) || null;
    await this.videosService.transition(video, VideoStatus.PROCESSING);
    await this.queueService.enqueueProcessing(videoId);

    return { res };
  }

  /**
   * Traduz erros de domínio para o envelope `{ statusCode, error, message }`
   * herdado de `phase-02-auth/TD-07`.
   */
  private onResponseError(
    res: http.ServerResponse,
    err: Error | { status_code: number; body: string },
  ): Promise<{ status_code: number; body: string } | undefined> {
    return Promise.resolve(this.mapErrorToEnvelope(res, err));
  }

  private mapErrorToEnvelope(
    res: http.ServerResponse,
    err: Error | { status_code: number; body: string },
  ): { status_code: number; body: string } | undefined {
    // O teto também é aplicado pela opção `maxSize` do próprio tus, que responde
    // 413 com corpo de texto puro. Traduzir aqui mantém um único contrato de
    // erro na fronteira, venha a recusa do hook ou do protocolo.
    const domainError =
      err instanceof DomainException ? err : this.asMaxSizeException(err);

    if (!domainError) {
      this.logger.error(
        `tus error: ${err instanceof Error ? err.stack : JSON.stringify(err)}`,
      );
      return undefined;
    }

    // O tus não define content-type ao escrever o corpo; sem isto o cliente
    // recebe JSON rotulado como texto.
    res.setHeader('Content-Type', 'application/json');
    this.logger.warn(
      `Upload rejected: ${domainError.errorCode} — ${domainError.message}`,
    );

    return {
      status_code: domainError.httpStatus,
      body: JSON.stringify({
        statusCode: domainError.httpStatus,
        error: domainError.errorCode,
        message: domainError.message,
      }),
    };
  }

  private asMaxSizeException(
    err: Error | { status_code?: number },
  ): UploadTooLargeException | undefined {
    const statusCode = (err as { status_code?: number }).status_code;
    return statusCode === 413
      ? new UploadTooLargeException(this.config.maxUploadBytes)
      : undefined;
  }
}
