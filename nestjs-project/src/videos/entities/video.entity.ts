import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';

/**
 * Ciclo de vida do vídeo (per `phase-03-videos/TD-05`).
 *
 * `visibility` (public / unlisted) é um eixo ortogonal, propriedade da Fase 04
 * — deliberadamente NÃO é um valor deste enum.
 */
export enum VideoStatus {
  DRAFT = 'draft',
  UPLOADING = 'uploading',
  PROCESSING = 'processing',
  READY = 'ready',
  FAILED = 'failed',
}

/** `numeric` e `bigint` voltam como string no driver pg; converte na borda. */
const numericTransformer = {
  to: (value: number | null): number | null => value,
  from: (value: string | null): number | null =>
    value === null ? null : Number(value),
};

@Entity('videos')
@Index(['channel_id', 'status'])
@Index(['status'])
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Identificador público de 11 chars base62 — o único que aparece em URL. */
  @Column({ type: 'varchar', length: 11, unique: true })
  public_id: string;

  @Column({ type: 'uuid' })
  channel_id: string;

  /** Semeado a partir do filename do upload (per `phase-03-videos/TD-05`). */
  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({
    type: 'enum',
    enum: VideoStatus,
    default: VideoStatus.DRAFT,
  })
  status: VideoStatus;

  @Column({ type: 'text', nullable: true })
  processing_error: string | null;

  /** Duração em segundos, extraída pelo ffprobe. */
  @Column({
    type: 'numeric',
    nullable: true,
    transformer: numericTransformer,
  })
  duration: number | null;

  @Column({ type: 'integer', nullable: true })
  width: number | null;

  @Column({ type: 'integer', nullable: true })
  height: number | null;

  /** Saída integral do ffprobe, preservada para evitar rebaixar o source. */
  @Column({ type: 'jsonb', nullable: true })
  ffprobe_metadata: Record<string, any> | null;

  /** Extensão do arquivo original; compõe a chave de storage e o filename. */
  @Column({ type: 'varchar', length: 16, nullable: true })
  source_ext: string | null;

  @Column({
    type: 'bigint',
    nullable: true,
    transformer: numericTransformer,
  })
  size_bytes: number | null;

  /** Id do upload tus — liga uma expiração de volta à sua row no reaping. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  upload_id: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @ManyToOne(() => Channel, (channel) => channel.videos)
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;
}
