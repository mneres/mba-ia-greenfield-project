import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import { StorageService } from '../storage/storage.service';
import { videoThumbnailKey } from '../storage/storage.keys';
import { VideoStatus } from '../videos/entities/video.entity';
import type { VideoProcessJobData } from '../videos/video-queue.service';
import {
  VIDEO_PROCESSING_QUEUE,
  VIDEO_PROCESS_JOB_OPTIONS,
  VIDEO_REAP_JOB,
} from '../videos/videos.constants';
import { VideosService } from '../videos/videos.service';
import { extractThumbnail, findVideoStream, probe } from './ffmpeg.util';
import { ReaperProcessor } from './reaper.processor';

/** Fração da duração usada para o quadro do thumbnail (per `TD-10`). */
const THUMBNAIL_POSITION_RATIO = 0.1;

const NO_VIDEO_STREAM_MESSAGE =
  'Uploaded file contains no video stream — the declared content type is not trusted';

/**
 * Consome `video.process` (per `phase-03-videos/TD-07`, `TD-08`).
 *
 * Registrado **apenas** aqui: no processo da API, `manualRegistration: true`
 * impede que qualquer `@Processor` vire Worker, e é isso que garante que uma
 * transcodificação nunca dispute CPU com o event loop que atende requisições.
 */
@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    private readonly videosService: VideosService,
    private readonly storageService: StorageService,
    private readonly reaperProcessor: ReaperProcessor,
  ) {
    super();
  }

  /**
   * Despacha por nome de job.
   *
   * O BullMQ entrega por **fila**, não por nome: um segundo `@Processor` sobre
   * `video-processing` criaria outro Worker competindo pelos mesmos jobs, e
   * cada um receberia os do outro tipo. Como TD-17 põe o `reap` nesta mesma
   * fila, o despacho tem que acontecer aqui.
   */
  async process(job: Job<VideoProcessJobData>): Promise<void> {
    if (job.name === VIDEO_REAP_JOB) {
      await this.reaperProcessor.reap();
      return;
    }

    const { videoId } = job.data;

    const video = await this.videosService.findById(videoId);
    if (!video) {
      // A row sumiu entre o enfileiramento e o consumo. Retentar não a traria
      // de volta.
      throw new UnrecoverableError(`Video ${videoId} no longer exists`);
    }
    if (video.status === VideoStatus.READY) {
      // `ready` é terminal (TD-05): um job duplicado não reprocessa.
      return;
    }

    const workDir = await mkdtemp(join(tmpdir(), `video-${videoId}-`));
    try {
      if (!video.upload_id) {
        // Sem chave de storage não há o que processar; nenhum retry resolve.
        throw new UnrecoverableError(
          `Video ${videoId} has no upload_id — nothing to process`,
        );
      }

      const sourcePath = join(workDir, 'source');
      await this.storageService.downloadToFile(
        this.storageService.videosBucket,
        video.upload_id,
        sourcePath,
      );

      const metadata = await probe(sourcePath);
      const videoStream = findVideoStream(metadata);

      if (!videoStream) {
        // Falha permanente, não transitória: o arquivo não vai virar vídeo numa
        // segunda tentativa. `UnrecoverableError` encerra o job sem consumir as
        // 3 tentativas em erro genérico (per `TD-04`, `TD-11`).
        await this.videosService.transition(
          video,
          VideoStatus.FAILED,
          NO_VIDEO_STREAM_MESSAGE,
        );
        throw new UnrecoverableError(NO_VIDEO_STREAM_MESSAGE);
      }

      video.duration = metadata.format.duration
        ? Number(metadata.format.duration)
        : null;
      video.width = videoStream.width ?? null;
      video.height = videoStream.height ?? null;
      // O payload inteiro, não só os três campos: ~5KB por vídeo evitam ter que
      // rebaixar um arquivo de vários GB para recomputar um campo descoberto
      // depois (per `TD-09` Revision).
      video.ffprobe_metadata = metadata as unknown as Record<string, unknown>;

      const thumbnailPath = join(workDir, 'thumb.jpg');
      await extractThumbnail(
        sourcePath,
        (video.duration ?? 0) * THUMBNAIL_POSITION_RATIO,
        thumbnailPath,
      );

      // Chave determinística: um retry sobrescreve em vez de acumular
      // (per `TD-02`, `TD-10`, `TD-11`).
      // Buffer aqui é seguro: o thumbnail é um JPEG de ~100KB, ao contrário do
      // source, que é baixado em streaming.
      await this.storageService.putObject(
        this.storageService.thumbnailsBucket,
        videoThumbnailKey(videoId),
        await readFile(thumbnailPath),
        'image/jpeg',
      );

      await this.videosService.transition(video, VideoStatus.READY);
      this.logger.log(`Video ${videoId} processed successfully`);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  /**
   * Última tentativa esgotada: o vídeo vira `failed` com o motivo registrado.
   *
   * Só aqui, e não dentro de `process`, porque uma falha transitória ainda tem
   * retry pela frente e não deve marcar o vídeo como perdido. A exceção é o
   * caso sem stream de vídeo, que já transiciona lá por ser permanente.
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<VideoProcessJobData>, error: Error): Promise<void> {
    // O job de recolhimento não tem vídeo associado para marcar como falho.
    if (job.name === VIDEO_REAP_JOB) {
      this.logger.error(`Reaper run failed: ${error.message}`);
      return;
    }

    const attemptsAllowed =
      job.opts.attempts ?? VIDEO_PROCESS_JOB_OPTIONS.attempts;
    const isFinalAttempt =
      error instanceof UnrecoverableError ||
      job.attemptsMade >= attemptsAllowed;

    if (!isFinalAttempt) {
      this.logger.warn(
        `Video ${job.data.videoId} attempt ${job.attemptsMade}/${attemptsAllowed} failed: ${error.message}`,
      );
      return;
    }

    const video = await this.videosService.findById(job.data.videoId);
    // `failed` é terminal: se o caminho permanente já transicionou, nada a fazer.
    if (!video || video.status === VideoStatus.FAILED) return;

    await this.videosService.transition(
      video,
      VideoStatus.FAILED,
      error.message,
    );
    this.logger.error(`Video ${job.data.videoId} failed: ${error.message}`);
  }
}
