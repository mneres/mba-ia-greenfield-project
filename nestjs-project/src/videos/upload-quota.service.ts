import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { ConfigType } from '@nestjs/config';
import { In, Repository } from 'typeorm';
import { UploadQuotaExceededException } from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import { Video, VideoStatus } from './entities/video.entity';

/** Estados que contam como "upload em andamento" para a cota de concorrência. */
const IN_FLIGHT_STATUSES = [VideoStatus.DRAFT, VideoStatus.UPLOADING];

/**
 * Cota de upload por canal (per `phase-03-videos/TD-16`).
 *
 * Roda dentro do `onUploadCreate` do tus, que é o único ponto em que a checagem
 * acontece *antes* de qualquer byte ser gravado. Um limite por taxa de
 * requisição não serviria: a 50MB por parte, um upload de 10GB emite ~200
 * PATCHes, então não há como separar um upload legítimo grande de abuso — e os
 * bytes agregados ficariam sem teto de qualquer forma.
 */
@Injectable()
export class UploadQuotaService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  async assertWithinQuota(channelId: string): Promise<void> {
    await this.assertConcurrencyAvailable(channelId);
    await this.assertStorageAvailable(channelId);
  }

  private async assertConcurrencyAvailable(channelId: string): Promise<void> {
    // COUNT indexado pelo índice composto (channel_id, status) de SI-03.3.
    const inFlight = await this.videoRepository.count({
      where: { channel_id: channelId, status: In(IN_FLIGHT_STATUSES) },
    });

    const limit = this.config.maxConcurrentUploadsPerUser;
    if (inFlight >= limit) {
      throw new UploadQuotaExceededException(
        `Channel already has ${inFlight} uploads in progress (limit ${limit})`,
      );
    }
  }

  private async assertStorageAvailable(channelId: string): Promise<void> {
    const row = await this.videoRepository
      .createQueryBuilder('video')
      .select('COALESCE(SUM(video.size_bytes), 0)', 'total')
      .where('video.channel_id = :channelId', { channelId })
      .getRawOne<{ total: string }>();

    // SUM sobre bigint volta como string no driver pg.
    const stored = Number(row?.total ?? 0);
    const limit = this.config.maxTotalBytesPerUser;

    if (stored >= limit) {
      throw new UploadQuotaExceededException(
        `Channel already stores ${stored} bytes (limit ${limit})`,
      );
    }
  }
}
