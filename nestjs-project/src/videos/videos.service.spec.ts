import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { Repository } from 'typeorm';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosService } from './videos.service';

const ALL_STATUSES = Object.values(VideoStatus);

/** Matriz de referência do TD-05 — a fonte de verdade do teste. */
const VALID: ReadonlyArray<[VideoStatus, VideoStatus]> = [
  [VideoStatus.DRAFT, VideoStatus.UPLOADING],
  [VideoStatus.DRAFT, VideoStatus.FAILED],
  [VideoStatus.UPLOADING, VideoStatus.PROCESSING],
  [VideoStatus.UPLOADING, VideoStatus.FAILED],
  [VideoStatus.PROCESSING, VideoStatus.READY],
  [VideoStatus.PROCESSING, VideoStatus.FAILED],
];

const isValid = (from: VideoStatus, to: VideoStatus): boolean =>
  VALID.some(([f, t]) => f === from && t === to);

describe('VideosService', () => {
  let service: VideosService;
  let repository: jest.Mocked<Pick<Repository<Video>, 'save'>>;

  beforeEach(async () => {
    repository = { save: jest.fn((v: Video) => Promise.resolve(v)) as never };

    const moduleRef = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: repository },
      ],
    }).compile();

    service = moduleRef.get(VideosService);
  });

  const videoWith = (status: VideoStatus): Video =>
    ({ id: 'video-1', status, processing_error: null }) as Video;

  describe('canTransition — full matrix', () => {
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        const expected = isValid(from, to);
        it(`should ${expected ? 'allow' : 'reject'} ${from} -> ${to}`, () => {
          expect(service.canTransition(from, to)).toBe(expected);
        });
      }
    }
  });

  describe('terminal states', () => {
    it('should allow no transition out of ready', () => {
      for (const to of ALL_STATUSES) {
        expect(service.canTransition(VideoStatus.READY, to)).toBe(false);
      }
    });

    it('should allow no transition out of failed', () => {
      for (const to of ALL_STATUSES) {
        expect(service.canTransition(VideoStatus.FAILED, to)).toBe(false);
      }
    });
  });

  describe('transition', () => {
    it('should reject a direct jump from draft to ready', async () => {
      const video = videoWith(VideoStatus.DRAFT);

      await expect(service.transition(video, VideoStatus.READY)).rejects.toThrow(
        'Invalid video transition: draft -> ready',
      );
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('should persist a valid transition', async () => {
      const video = videoWith(VideoStatus.PROCESSING);

      const result = await service.transition(video, VideoStatus.READY);

      expect(result.status).toBe(VideoStatus.READY);
      expect(repository.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: VideoStatus.READY }),
      );
    });

    it('should record processing_error when moving to failed', async () => {
      const video = videoWith(VideoStatus.PROCESSING);

      const result = await service.transition(
        video,
        VideoStatus.FAILED,
        'no video stream',
      );

      expect(result.status).toBe(VideoStatus.FAILED);
      expect(result.processing_error).toBe('no video stream');
    });

    it('should not attach processing_error on a non-failed transition', async () => {
      const video = videoWith(VideoStatus.PROCESSING);

      const result = await service.transition(
        video,
        VideoStatus.READY,
        'ignorado',
      );

      expect(result.processing_error).toBeNull();
    });
  });
});
