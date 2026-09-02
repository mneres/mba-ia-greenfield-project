import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import appConfig from '../config/app.config';
import databaseConfig from '../config/database.config';
import { ALL_ENTITIES } from '../database/entities';
import { envValidationSchema } from '../config/env.validation';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { Video } from '../videos/entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from '../videos/videos.constants';
import { VideosService } from '../videos/videos.service';
import { VideoProcessor } from './video.processor';

/**
 * Raiz do processo `video-worker` (per `phase-03-videos/TD-08`).
 *
 * Reaproveita as mesmas factories de config, a mesma conexão de banco e o
 * mesmo `StorageModule` da API — nada de bootstrap duplicado. O que difere é o
 * que *não* está aqui: nenhum controller, nenhum servidor HTTP.
 *
 * Ao contrário do `AppModule`, o BullMQ é registrado **sem**
 * `manualRegistration`: é justamente aqui que os `@Processor` devem virar
 * Workers de verdade.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, databaseConfig, storageConfig, queueConfig],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres' as const,
        host: dbConfig.host,
        port: dbConfig.port,
        username: dbConfig.username,
        password: dbConfig.password,
        database: dbConfig.name,
        // Lista explícita, não `autoLoadEntities`: o worker registra só o
        // `forFeature` de `Video`, e o autoLoad carregaria apenas essa
        // entidade — deixando `Channel` e `User`, do outro lado das relações,
        // de fora.
        entities: ALL_ENTITIES,
        synchronize: false,
      }),
    }),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [queueConfig.KEY],
      useFactory: (queue: ConfigType<typeof queueConfig>) => ({
        connection: { host: queue.host, port: queue.port },
      }),
    }),
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
    // `VideosService` é registrado aqui em vez de importar o `VideosModule`:
    // aquele módulo carrega o controller e o serviço de ingest tus, que não
    // têm razão de existir num processo sem HTTP.
    TypeOrmModule.forFeature([Video]),
    StorageModule,
  ],
  providers: [VideosService, VideoProcessor],
})
export class WorkerModule {}
