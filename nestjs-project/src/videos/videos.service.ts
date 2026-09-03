import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { VideoNotFoundException } from '../common/exceptions/domain.exception';
import { Video, VideoStatus } from './entities/video.entity';
import { generatePublicId } from './public-id.util';

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

const PG_UNIQUE_VIOLATION = '23505';
const PUBLIC_ID_COLUMN = 'public_id';
const MAX_PUBLIC_ID_ATTEMPTS = 3;

/** Forma da falha do driver `pg` que o TypeORM embrulha em `QueryFailedError`. */
interface PostgresDriverError {
  code?: string;
  detail?: string;
}

function isPublicIdConflict(err: unknown): boolean {
  if (!(err instanceof QueryFailedError)) return false;

  // `detail` distingue qual UNIQUE falhou: a mesma tabela pode ganhar outras
  // constraints em fases seguintes, e retentar um id novo não resolveria nenhuma
  // delas.
  const driverError = err.driverError as PostgresDriverError | undefined;
  return (
    driverError?.code === PG_UNIQUE_VIOLATION &&
    typeof driverError.detail === 'string' &&
    driverError.detail.includes(PUBLIC_ID_COLUMN)
  );
}

export interface CreateVideoData {
  channel_id: string;
  title: string;
  /**
   * PK explícita. O ingest tus escolhe o id antes de a row existir, porque a
   * chave de storage o carrega embutido (per `phase-03-videos/TD-02`); quando
   * omitido, o banco gera.
   */
  id?: string;
  /** Id do upload tus, que é também a chave do objeto no bucket privado. */
  upload_id?: string;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
  ) {}

  /**
   * Cria o rascunho do vídeo com um `public_id` recém-sorteado.
   *
   * Sem SELECT prévio, ao contrário do retry de nickname em `ChannelsService`:
   * lá a base é derivada do e-mail e colidir é o caso normal, aqui o id é
   * aleatório sobre ~65 bits e a colisão é o caso patológico. A UNIQUE do banco
   * é o árbitro — é o que transforma "nunca conflita" de argumento
   * probabilístico em garantia (per `phase-03-videos/TD-06`).
   */
  async create(data: CreateVideoData): Promise<Video> {
    for (let attempt = 0; attempt < MAX_PUBLIC_ID_ATTEMPTS; attempt++) {
      try {
        return await this.videoRepository.save(
          this.videoRepository.create({
            ...(data.id !== undefined && { id: data.id }),
            ...(data.upload_id !== undefined && { upload_id: data.upload_id }),
            public_id: generatePublicId(),
            channel_id: data.channel_id,
            title: data.title,
          }),
        );
      } catch (err) {
        if (!isPublicIdConflict(err)) throw err;
      }
    }

    throw new Error(
      `Could not generate a unique public_id after ${MAX_PUBLIC_ID_ATTEMPTS} attempts`,
    );
  }

  /**
   * Marca o início da chegada de bytes, sem lançar em concorrência.
   *
   * Um UPDATE condicional em vez de `transition`: o evento de progresso do tus
   * e o hook de conclusão podem disparar quase juntos num upload de uma só
   * parte, e uma corrida ali viraria "transição inválida" — isto é idempotente
   * por construção, e a condição no WHERE mantém a máquina de estados do TD-05
   * como árbitro.
   */
  async markUploading(videoId: string): Promise<void> {
    await this.videoRepository.update(
      { id: videoId, status: VideoStatus.DRAFT },
      { status: VideoStatus.UPLOADING },
    );
  }

  /**
   * Resolve um vídeo para entrega, barrando por **estado do recurso**, não por
   * identidade (per `phase-03-videos/TD-15`).
   *
   * Anônimos e autenticados alcançam qualquer vídeo `ready`; o dono alcança
   * também os seus ainda não prontos. Todo o resto lança `VIDEO_NOT_FOUND` —
   * nunca `403`, que confirmaria a existência do recurso.
   *
   * A Fase 04 encaixa `visibility` aqui como um segundo predicado, no mesmo
   * método.
   */
  async resolveForDelivery(publicId: string, userId?: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId },
      relations: { channel: true },
    });

    if (!video) throw new VideoNotFoundException();
    if (video.status === VideoStatus.READY) return video;

    const isOwner = userId !== undefined && video.channel?.user_id === userId;
    if (!isOwner) throw new VideoNotFoundException();

    return video;
  }

  async findById(id: string): Promise<Video | null> {
    return this.videoRepository.findOneBy({ id });
  }

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
