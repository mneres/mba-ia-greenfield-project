import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Video } from './entities/video.entity';
import { VideosService } from './videos.service';

@Module({
  imports: [TypeOrmModule.forFeature([Video])],
  providers: [VideosService],
  exports: [VideosService],
})
export class VideosModule {}
