import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import { createTestQueue, type TestQueue } from '../test/create-test-queue';
import type { VideoProcessJobData } from './video-queue.service';
import { VideoQueueService } from './video-queue.service';
import { VIDEO_PROCESSING_QUEUE, VIDEO_PROCESS_JOB } from './videos.constants';

describe('VideoQueueService (integration)', () => {
  let testQueue: TestQueue<VideoProcessJobData>;
  let service: VideoQueueService;

  beforeAll(async () => {
    testQueue = await createTestQueue<VideoProcessJobData>('video-queue');

    // A fila isolada é injetada sob o token de produção, então o serviço roda
    // sem alteração enquanto os jobs ficam numa fila só desta suíte.
    const moduleRef = await Test.createTestingModule({
      providers: [
        VideoQueueService,
        {
          provide: getQueueToken(VIDEO_PROCESSING_QUEUE),
          useValue: testQueue.queue,
        },
      ],
    }).compile();

    service = moduleRef.get(VideoQueueService);
  }, 30000);

  afterAll(async () => {
    await testQueue.close();
  });

  beforeEach(async () => {
    await testQueue.queue.drain();
    await testQueue.queue.clean(0, 1000, 'completed');
    await testQueue.queue.clean(0, 1000, 'failed');
  });

  it('should enqueue the job with the payload the worker expects', async () => {
    const videoId = randomUUID();

    await service.enqueueProcessing(videoId);

    const [job] = await testQueue.queue.getJobs(['waiting']);
    expect(job.name).toBe(VIDEO_PROCESS_JOB);
    expect(job.data).toEqual({ videoId });
  });

  it('should apply the bounded retry policy from TD-11', async () => {
    await service.enqueueProcessing(randomUUID());

    const [job] = await testQueue.queue.getJobs(['waiting']);
    expect(job.opts.attempts).toBe(3);
    expect(job.opts.backoff).toEqual({ type: 'exponential', delay: 30_000 });
  });

  it('should retain failed jobs for diagnostics', async () => {
    await service.enqueueProcessing(randomUUID());

    const [job] = await testQueue.queue.getJobs(['waiting']);
    expect(job.opts.removeOnFail).toBe(false);
  });

  it('should not enqueue a second job for a videoId already in flight', async () => {
    const videoId = randomUUID();

    await service.enqueueProcessing(videoId);
    await service.enqueueProcessing(videoId);

    // Nenhum Worker consome nesta suíte, então o primeiro job segue pendente e
    // a deduplicação Simple Mode barra o segundo.
    const waiting = await testQueue.queue.getJobs(['waiting']);
    expect(waiting).toHaveLength(1);
    expect(waiting[0].data).toEqual({ videoId });
  });

  it('should still enqueue separate jobs for different videos', async () => {
    const first = randomUUID();
    const second = randomUUID();

    await service.enqueueProcessing(first);
    await service.enqueueProcessing(second);

    const waiting = await testQueue.queue.getJobs(['waiting']);
    expect(waiting).toHaveLength(2);
    expect(waiting.map((job) => job.data.videoId).sort()).toEqual(
      [first, second].sort(),
    );
  });

  it('should leave the job unconsumed — the API process hosts no Worker', async () => {
    await service.enqueueProcessing(randomUUID());

    await new Promise((resolve) => setTimeout(resolve, 500));

    const counts = await testQueue.queue.getJobCounts('waiting', 'active');
    expect(counts).toEqual({ waiting: 1, active: 0 });
  });
});
