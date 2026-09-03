import {
  createTestStorage,
  type TestStorage,
} from '../test/create-test-storage';
import { videoSourceKey, videoThumbnailKey } from './storage.keys';

describe('StorageService (integration)', () => {
  let storage: TestStorage;
  const written: Array<{ bucket: string; key: string }> = [];

  beforeAll(async () => {
    storage = await createTestStorage('storage-service');
  }, 30000);

  afterAll(async () => {
    for (const { bucket, key } of written) {
      await storage.service.deleteObject(bucket, key).catch(() => undefined);
    }
    await storage.close();
  }, 30000);

  const put = async (
    bucket: string,
    key: string,
    body: Buffer,
    type?: string,
  ) => {
    await storage.service.putObject(bucket, key, body, type);
    written.push({ bucket, key });
  };

  describe('bucket bootstrap', () => {
    it('should be idempotent when both buckets already exist', async () => {
      await expect(
        storage.service.ensureBucket(storage.service.videosBucket, false),
      ).resolves.toBeUndefined();
      await expect(
        storage.service.ensureBucket(storage.service.thumbnailsBucket, true),
      ).resolves.toBeUndefined();
    }, 30000);
  });

  describe('object round-trip', () => {
    it('should write and read back an object from the private bucket', async () => {
      const key = `${storage.prefix}${videoSourceKey('vid-1', '.mp4')}`;
      const body = Buffer.from('fake-video-bytes');

      await put(storage.service.videosBucket, key, body, 'video/mp4');
      const read = await storage.service.getObjectBuffer(
        storage.service.videosBucket,
        key,
      );

      expect(read.toString()).toBe('fake-video-bytes');
    }, 30000);
  });

  describe('bucket access policy', () => {
    it('should refuse anonymous reads from the private videos bucket', async () => {
      const key = `${storage.prefix}${videoSourceKey('vid-2', '.mp4')}`;
      await put(storage.service.videosBucket, key, Buffer.from('private'));

      const response = await fetch(
        `${process.env.STORAGE_ENDPOINT}/${storage.service.videosBucket}/${key}`,
      );

      expect(response.ok).toBe(false);
      expect([401, 403]).toContain(response.status);
    }, 30000);

    it('should allow anonymous reads from the public thumbnails bucket', async () => {
      const key = `${storage.prefix}${videoThumbnailKey('vid-3')}`;
      await put(
        storage.service.thumbnailsBucket,
        key,
        Buffer.from('jpeg'),
        'image/jpeg',
      );

      const response = await fetch(
        `${process.env.STORAGE_ENDPOINT}/${storage.service.thumbnailsBucket}/${key}`,
      );

      expect(response.ok).toBe(true);
      expect(await response.text()).toBe('jpeg');
    }, 30000);
  });

  describe('presigned URLs', () => {
    it('should sign against the public endpoint, not the internal one', async () => {
      const key = `${storage.prefix}${videoSourceKey('vid-4', '.mp4')}`;
      await put(storage.service.videosBucket, key, Buffer.from('signed'));

      const url = await storage.service.presignGet(
        storage.service.videosBucket,
        key,
        600,
      );

      expect(url.startsWith(process.env.STORAGE_PUBLIC_ENDPOINT!)).toBe(true);
      expect(url.startsWith(process.env.STORAGE_ENDPOINT!)).toBe(false);
    }, 30000);

    it('should use path-style addressing so the bucket is part of the path', async () => {
      const key = `${storage.prefix}${videoSourceKey('vid-5', '.mp4')}`;
      await put(storage.service.videosBucket, key, Buffer.from('path-style'));

      const url = await storage.service.presignGet(
        storage.service.videosBucket,
        key,
        600,
      );

      expect(url).toContain(`/${storage.service.videosBucket}/${key}`);
    }, 30000);

    it('should carry the requested expiry into the signed URL', async () => {
      const key = `${storage.prefix}${videoSourceKey('vid-6', '.mp4')}`;
      await put(storage.service.videosBucket, key, Buffer.from('expiry'));

      const url = await storage.service.presignGet(
        storage.service.videosBucket,
        key,
        21600,
      );

      // 21600 é o TTL de playback; o default da lib seria 900.
      expect(url).toContain('X-Amz-Expires=21600');
    }, 30000);

    it('should embed the content-disposition override as a signed query param', async () => {
      const key = `${storage.prefix}${videoSourceKey('vid-7', '.mp4')}`;
      await put(storage.service.videosBucket, key, Buffer.from('download'));

      const url = await storage.service.presignGet(
        storage.service.videosBucket,
        key,
        600,
        'attachment; filename="Minha Ferias.mp4"',
      );

      expect(url).toContain('response-content-disposition=');
      expect(decodeURIComponent(url)).toContain('attachment; filename=');
    }, 30000);
  });
});
