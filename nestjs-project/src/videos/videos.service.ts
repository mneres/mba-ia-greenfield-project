import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Video, VideoStatus } from './entities/video.entity';

/**
 * Transições permitidas do ciclo de vida (per `phase-03-videos/TD-05`).
 *
 * `ready` e `failed` são terminais: TD-11 não prevê reprocessamento automático,
 * e o reaper de TD-17 leva rascunhos abandonados a `failed`, nunca de volta.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<VideoStatus, VideoStatus[]>> = {
  [VideoStatus.DRAFT]: [VideoStatus.UPLOADING, VideoStatus.FAILED],
  [VideoStatus.UPLOADING]: [VideoStatus.PROCESSING, VideoStatus.FAILED],
  [VideoStatus.PROCESSING]: [VideoStatus.READY, VideoStatus.FAILED],
  [VideoStatus.READY]: [],
  [VideoStatus.FAILED]: [],
} as const;

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
  ) {}

  canTransition(from: VideoStatus, to: VideoStatus): boolean {
    return ALLOWED_TRANSITIONS[from].includes(to);
  }

  /**
   * Aplica uma transição de estado, recusando saltos fora da ordem definida.
   * `processing_error` só é aceito junto de uma transição para `failed`.
   */
  async transition(
    video: Video,
    to: VideoStatus,
    processingError?: string,
  ): Promise<Video> {
    // Erro de programação, não de entrada do usuário: nenhum endpoint desta
    // fase deixa o cliente pedir uma transição arbitrária, então isto não é um
    // DomainException e não entra no Error Catalog.
    if (!this.canTransition(video.status, to)) {
      throw new Error(
        `Invalid video transition: ${video.status} -> ${to} (video ${video.id})`,
      );
    }

    video.status = to;
    if (to === VideoStatus.FAILED) {
      video.processing_error = processingError ?? null;
    }

    return this.videoRepository.save(video);
  }
}
