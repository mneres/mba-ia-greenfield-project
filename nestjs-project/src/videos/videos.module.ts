import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Video } from './entities/video.entity';
import { VideoQueueService } from './video-queue.service';
import { VIDEO_PROCESSING_QUEUE } from './videos.constants';
import { VideosService } from './videos.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    // Sem o array `processors`: ele criaria um Worker neste mesmo processo,
    // que é exatamente o que TD-08 evita. Aqui a fila só produz.
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
  ],
  providers: [VideosService, VideoQueueService],
  exports: [VideosService, VideoQueueService],
})
export class VideosModule {}
