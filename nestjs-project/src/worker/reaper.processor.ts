import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Server } from '@tus/server';
import { Queue } from 'bullmq';
import { LessThan, Repository, In } from 'typeorm';
import storageConfig from '../config/storage.config';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { createTusS3Store } from '../videos/tus-store.factory';
import {
  REAPER_INTERVAL_MS,
  REAPER_SCHEDULER_ID,
  TUS_UPLOAD_PATH,
  VIDEO_PROCESSING_QUEUE,
  VIDEO_REAP_JOB,
} from '../videos/videos.constants';
import { VideosService } from '../videos/videos.service';

/** Estados em que uma row ainda espera bytes e portanto pode ser abandonada. */
const REAPABLE_STATUSES = [VideoStatus.DRAFT, VideoStatus.UPLOADING];

const EXPIRED_MESSAGE =
  'Upload abandoned — expired before completion and was reclaimed';

export interface ReapResult {
  objectsRemoved: number;
  videosFailed: number;
}

/**
 * Recolhe uploads tus abandonados e as rows que ficariam presas esperando
 * bytes que nunca chegam (per `phase-03-videos/TD-17`).
 *
 * **Nao** e um `@Processor`: `VideoProcessor` ja e o `WorkerHost` da fila
 * `video-processing`, e um segundo `@Processor` sobre a mesma fila criaria um
 * segundo Worker competindo por ela — cada um receberia jobs do outro tipo,
 * porque o BullMQ entrega por fila, nao por nome de job. O despacho por
 * `job.name` fica no `VideoProcessor`.
 */
@Injectable()
export class ReaperProcessor implements OnModuleInit {
  private readonly logger = new Logger(ReaperProcessor.name);
  private readonly tusServer: Server;

  constructor(
    private readonly videosService: VideosService,
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    // Server proprio, sem rota montada: o que a API monta como controller nao
    // e alcancavel deste processo (per `TD-17` Revision). Existe apenas para
    // dar acesso a `cleanUpExpiredUploads()`.
    this.tusServer = new Server({
      path: TUS_UPLOAD_PATH,
      datastore: createTusS3Store(this.config),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.registerSchedule();
  }

  /**
   * Agenda a execucao horaria.
   *
   * `upsertJobScheduler` e a API de Job Scheduler da v6 — `queue.add(...,
   * { repeat })` e a forma legada da v5, e `QueueScheduler` nao existe mais. E
   * idempotente por id de scheduler, entao chamar a cada boot do worker e
   * seguro (per `TD-17`).
   */
  async registerSchedule(): Promise<void> {
    await this.queue.upsertJobScheduler(
      REAPER_SCHEDULER_ID,
      { every: REAPER_INTERVAL_MS },
      { name: VIDEO_REAP_JOB, data: {}, opts: { attempts: 3 } },
    );
    this.logger.log(
      `Reaper scheduled every ${REAPER_INTERVAL_MS / 60_000} minutes`,
    );
  }

  /**
   * Uma execucao: limpa o storage e o banco na mesma passagem, para que os dois
   * nao possam discordar sobre o que foi recolhido.
   */
  async reap(): Promise<ReapResult> {
    const objectsRemoved = await this.tusServer.cleanUpExpiredUploads();
    const videosFailed = await this.failExpiredVideos();

    if (objectsRemoved || videosFailed) {
      this.logger.log(
        `Reaped ${objectsRemoved} expired uploads and failed ${videosFailed} stale videos`,
      );
    }

    return { objectsRemoved, videosFailed };
  }

  /**
   * Leva a `failed` toda row cujo upload expirou, **preservando a row**: ela e
   * a unica evidencia de que o usuario tentou enviar algo, e TD-05 ja tem um
   * estado terminal para exatamente isto (per `TD-17`).
   */
  private async failExpiredVideos(): Promise<number> {
    const cutoff = new Date(
      Date.now() - this.config.uploadExpirationHours * 60 * 60 * 1000,
    );

    const stale = await this.videoRepository.find({
      where: {
        status: In(REAPABLE_STATUSES),
        created_at: LessThan(cutoff),
      },
    });

    for (const video of stale) {
      await this.videosService.transition(
        video,
        VideoStatus.FAILED,
        EXPIRED_MESSAGE,
      );
    }

    return stale.length;
  }
}
