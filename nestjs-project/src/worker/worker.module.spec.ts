import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { VIDEO_PROCESSING_QUEUE } from '../videos/videos.constants';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  it('should compile outside an HTTP context and resolve its infrastructure', async () => {
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    // init() sobe o contexto standalone — é o que `createApplicationContext`
    // faz em `main.worker.ts`, sem servidor HTTP no meio.
    await module.init();

    expect(module.get(DataSource).isInitialized).toBe(true);
    expect(module.get(StorageService)).toBeInstanceOf(StorageService);
    expect(module.get(getQueueToken(VIDEO_PROCESSING_QUEUE))).toBeDefined();

    await module.close();
  }, 60000);

  it('should register no controllers — the worker exposes no HTTP surface', () => {
    const controllers = Reflect.getMetadata('controllers', WorkerModule) as
      | unknown[]
      | undefined;

    expect(controllers ?? []).toHaveLength(0);
  });
});
