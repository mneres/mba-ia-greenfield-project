import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { Repository } from 'typeorm';
import { VideoNotFoundException } from '../common/exceptions/domain.exception';
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
  let repository: jest.Mocked<Pick<Repository<Video>, 'save' | 'findOne'>>;

  beforeEach(async () => {
    repository = {
      save: jest.fn((v: Video) => Promise.resolve(v)) as never,
      findOne: jest.fn() as never,
    };

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

      await expect(
        service.transition(video, VideoStatus.READY),
      ).rejects.toThrow('Invalid video transition: draft -> ready');
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

  describe('resolveForDelivery — authorization matrix (TD-15)', () => {
    const OWNER_ID = 'user-owner';
    const OTHER_ID = 'user-other';
    const PUBLIC_ID = 'aaaaaaaaaaa';

    const storedVideo = (status: VideoStatus): Video =>
      ({
        id: 'video-1',
        public_id: PUBLIC_ID,
        status,
        channel: { user_id: OWNER_ID },
      }) as Video;

    /** Cada caller da matriz, com o userId que o controller passaria. */
    const CALLERS: ReadonlyArray<[string, string | undefined]> = [
      ['anonymous', undefined],
      ['authenticated non-owner', OTHER_ID],
      ['owner', OWNER_ID],
    ];

    for (const status of Object.values(VideoStatus)) {
      for (const [callerName, userId] of CALLERS) {
        const isOwner = userId === OWNER_ID;
        const shouldResolve = status === VideoStatus.READY || isOwner;

        it(`should ${shouldResolve ? 'resolve' : 'reject'} ${status} for ${callerName}`, async () => {
          repository.findOne.mockResolvedValue(storedVideo(status) as never);

          if (shouldResolve) {
            const video = await service.resolveForDelivery(PUBLIC_ID, userId);
            expect(video.public_id).toBe(PUBLIC_ID);
          } else {
            await expect(
              service.resolveForDelivery(PUBLIC_ID, userId),
            ).rejects.toThrow(VideoNotFoundException);
          }
        });
      }
    }

    it('should reject an unknown publicId with the same exception as a hidden one', async () => {
      repository.findOne.mockResolvedValue(null as never);

      const missing = await service
        .resolveForDelivery('unknown0000')
        .catch((err: unknown) => err);

      repository.findOne.mockResolvedValue(
        storedVideo(VideoStatus.PROCESSING) as never,
      );
      const hidden = await service
        .resolveForDelivery(PUBLIC_ID)
        .catch((err: unknown) => err);

      // Mesmo código e mesma mensagem: é o que impede enumerar vídeos não
      // publicados comparando respostas.
      expect(missing).toBeInstanceOf(VideoNotFoundException);
      expect(hidden).toBeInstanceOf(VideoNotFoundException);
      expect((hidden as VideoNotFoundException).message).toBe(
        (missing as VideoNotFoundException).message,
      );
      expect((hidden as VideoNotFoundException).errorCode).toBe(
        (missing as VideoNotFoundException).errorCode,
      );
    });

    it('should load the channel relation — ownership cannot be decided without it', async () => {
      repository.findOne.mockResolvedValue(
        storedVideo(VideoStatus.READY) as never,
      );

      await service.resolveForDelivery(PUBLIC_ID);

      expect(repository.findOne).toHaveBeenCalledWith({
        where: { public_id: PUBLIC_ID },
        relations: { channel: true },
      });
    });
  });
});
