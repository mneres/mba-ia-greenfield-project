import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { Video } from './entities/video.entity';
import { UploadController } from './upload.controller';
import { UploadQuotaService } from './upload-quota.service';
import { UploadService } from './upload.service';
import { VideoQueueService } from './video-queue.service';
import { VIDEO_PROCESSING_QUEUE } from './videos.constants';
import { VideosService } from './videos.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    // Sem o array `processors`: ele criaria um Worker neste mesmo processo,
    // que é exatamente o que TD-08 evita. Aqui a fila só produz.
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
    ChannelsModule,
  ],
  controllers: [UploadController],
  providers: [
    VideosService,
    VideoQueueService,
    UploadQuotaService,
    UploadService,
  ],
  exports: [VideosService, VideoQueueService],
})
export class VideosModule {}
