import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { ConfigType } from '@nestjs/config';
import databaseConfig from '../config/database.config';
import queueConfig from '../config/queue.config';
import { ALL_ENTITIES } from '../test/create-test-data-source';
import { VideoQueueService } from './video-queue.service';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

describe('VideosModule', () => {
  it('should compile successfully', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [databaseConfig, queueConfig],
        }),
        TypeOrmModule.forRootAsync({
          inject: [databaseConfig.KEY],
          useFactory: (db: ConfigType<typeof databaseConfig>) => ({
            type: 'postgres' as const,
            host: db.host,
            port: db.port,
            username: db.username,
            password: db.password,
            database: db.name,
            entities: ALL_ENTITIES,
            synchronize: false,
          }),
        }),
        BullModule.forRootAsync({
          inject: [queueConfig.KEY],
          useFactory: (queue: ConfigType<typeof queueConfig>) => ({
            connection: { host: queue.host, port: queue.port },
          }),
          extraOptions: { manualRegistration: true },
        }),
        VideosModule,
      ],
    }).compile();

    expect(module).toBeDefined();
    expect(module.get(VideosService)).toBeInstanceOf(VideosService);
    expect(module.get(VideoQueueService)).toBeInstanceOf(VideoQueueService);
    await module.close();
  }, 30000);
});
