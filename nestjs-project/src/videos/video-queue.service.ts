import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  VIDEO_PROCESSING_QUEUE,
  VIDEO_PROCESS_JOB,
  VIDEO_PROCESS_JOB_OPTIONS,
} from './videos.constants';

export interface VideoProcessJobData {
  videoId: string;
}

@Injectable()
export class VideoQueueService {
  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue<VideoProcessJobData>,
  ) {}

  /**
   * Enfileira o processamento de um vídeo.
   *
   * `deduplication: { id: videoId }` em Simple Mode é o que torna a operação
   * idempotente: nenhum job novo com esse id entra enquanto o atual não
   * completar ou falhar. Clientes tus reenviam o `PATCH` final, e sem isso cada
   * reenvio dispararia um transcode adicional do mesmo arquivo. É a forma que a
   * v6 dá ao `jobId = videoId` que TD-11 descreve (per `library-refs.md` →
   * `bullmq` § Correction 2).
   */
  async enqueueProcessing(videoId: string): Promise<void> {
    await this.queue.add(
      VIDEO_PROCESS_JOB,
      { videoId },
      { ...VIDEO_PROCESS_JOB_OPTIONS, deduplication: { id: videoId } },
    );
  }
}
