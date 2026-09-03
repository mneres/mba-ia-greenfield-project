import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

/**
 * `createApplicationContext`, não `create`: o worker não atende HTTP, então
 * subir um servidor seria porta aberta sem motivo (per `phase-03-videos/TD-08`).
 */
async function bootstrap(): Promise<void> {
  const context = await NestFactory.createApplicationContext(WorkerModule);
  context.enableShutdownHooks();

  const logger = new Logger('VideoWorker');
  logger.log('Video worker started — consuming from the processing queue');
}

void bootstrap();
