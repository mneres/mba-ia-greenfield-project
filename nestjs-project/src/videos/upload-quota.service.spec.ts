import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UploadQuotaExceededException } from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import { Video } from './entities/video.entity';
import { UploadQuotaService } from './upload-quota.service';

const MAX_CONCURRENT = 3;
const MAX_TOTAL_BYTES = 1000;
const CHANNEL_ID = 'channel-1';

describe('UploadQuotaService', () => {
  let service: UploadQuotaService;
  let count: jest.Mock;
  let getRawOne: jest.Mock;

  beforeEach(async () => {
    count = jest.fn().mockResolvedValue(0);
    getRawOne = jest.fn().mockResolvedValue({ total: '0' });

    const repository = {
      count,
      createQueryBuilder: jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getRawOne,
      })),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        UploadQuotaService,
        { provide: getRepositoryToken(Video), useValue: repository },
        {
          provide: storageConfig.KEY,
          useValue: {
            maxConcurrentUploadsPerUser: MAX_CONCURRENT,
            maxTotalBytesPerUser: MAX_TOTAL_BYTES,
          },
        },
      ],
    }).compile();

    service = moduleRef.get(UploadQuotaService);
  });

  describe('concurrency limit', () => {
    it.each([0, 1, MAX_CONCURRENT - 1])(
      'should allow a new upload with %i in flight',
      async (inFlight) => {
        count.mockResolvedValue(inFlight);

        await expect(
          service.assertWithinQuota(CHANNEL_ID),
        ).resolves.toBeUndefined();
      },
    );

    it('should reject exactly at the limit, not one past it', async () => {
      count.mockResolvedValue(MAX_CONCURRENT);

      await expect(service.assertWithinQuota(CHANNEL_ID)).rejects.toThrow(
        UploadQuotaExceededException,
      );
    });

    it('should reject above the limit', async () => {
      count.mockResolvedValue(MAX_CONCURRENT + 1);

      await expect(service.assertWithinQuota(CHANNEL_ID)).rejects.toThrow(
        UploadQuotaExceededException,
      );
    });

    it('should carry the 409 UPLOAD_QUOTA_EXCEEDED contract', async () => {
      count.mockResolvedValue(MAX_CONCURRENT);

      await expect(service.assertWithinQuota(CHANNEL_ID)).rejects.toMatchObject(
        {
          errorCode: 'UPLOAD_QUOTA_EXCEEDED',
          httpStatus: 409,
        },
      );
    });

    it('should count only the channel under check, in flight states only', async () => {
      await service.assertWithinQuota(CHANNEL_ID);

      const [criteria] = count.mock.calls[0] as [
        { where: { channel_id: string; status: { value: string[] } } },
      ];
      expect(criteria.where.channel_id).toBe(CHANNEL_ID);
      expect(criteria.where.status.value).toEqual(['draft', 'uploading']);
    });
  });

  describe('aggregate storage limit', () => {
    it('should allow when stored bytes are below the limit', async () => {
      getRawOne.mockResolvedValue({ total: String(MAX_TOTAL_BYTES - 1) });

      await expect(
        service.assertWithinQuota(CHANNEL_ID),
      ).resolves.toBeUndefined();
    });

    it('should reject exactly at the limit', async () => {
      getRawOne.mockResolvedValue({ total: String(MAX_TOTAL_BYTES) });

      await expect(service.assertWithinQuota(CHANNEL_ID)).rejects.toThrow(
        UploadQuotaExceededException,
      );
    });

    it('should treat a null SUM as zero rather than NaN', async () => {
      // SUM sobre zero linhas volta null; sem o COALESCE isto viraria NaN, e
      // NaN >= limite é false — a cota passaria a nunca barrar ninguém.
      getRawOne.mockResolvedValue({ total: null });

      await expect(
        service.assertWithinQuota(CHANNEL_ID),
      ).resolves.toBeUndefined();
    });

    it('should not run the storage query when concurrency already failed', async () => {
      count.mockResolvedValue(MAX_CONCURRENT);

      await expect(service.assertWithinQuota(CHANNEL_ID)).rejects.toThrow();
      expect(getRawOne).not.toHaveBeenCalled();
    });
  });
});
