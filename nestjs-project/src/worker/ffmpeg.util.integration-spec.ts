import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  FfmpegError,
  extractThumbnail,
  findVideoStream,
  probe,
  run,
} from './ffmpeg.util';

/**
 * Roda contra os binários reais, então **só passa dentro do container
 * `video-worker`** — a imagem da API não tem FFmpeg, por decisão do TD-08.
 *
 *   docker compose exec video-worker npm run test:worker
 */

const FIXTURES = join(__dirname, '..', 'test', 'fixtures');
const SAMPLE_VIDEO = join(FIXTURES, 'sample.mp4');
const SAMPLE_AUDIO = join(FIXTURES, 'sample-audio.m4a');

/** Dimensões e duração com que a fixture foi gerada. */
const EXPECTED = { width: 640, height: 360, durationSeconds: 2 };

describe('ffmpeg.util (integration)', () => {
  let workDir: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'ffmpeg-spec-'));
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  describe('probe', () => {
    it('should report duration, width and height matching the fixture', async () => {
      const result = await probe(SAMPLE_VIDEO);

      expect(Number(result.format.duration)).toBeCloseTo(
        EXPECTED.durationSeconds,
        0,
      );

      const video = findVideoStream(result);
      expect(video).toBeDefined();
      expect(video!.width).toBe(EXPECTED.width);
      expect(video!.height).toBe(EXPECTED.height);
    });

    it('should return the full stream list for the jsonb column', async () => {
      const result = await probe(SAMPLE_VIDEO);

      // A fixture tem vídeo e áudio; o payload inteiro vai para
      // `ffprobe_metadata` (TD-09 Revision).
      const codecTypes = result.streams.map((s) => s.codec_type).sort();
      expect(codecTypes).toEqual(['audio', 'video']);
      expect(result.format.format_name).toContain('mp4');
    });

    it('should return a stream list without a video entry, not throw, for audio-only input', async () => {
      const result = await probe(SAMPLE_AUDIO);

      expect(result.streams.length).toBeGreaterThan(0);
      expect(findVideoStream(result)).toBeUndefined();
    });

    it('should reject with the captured stderr when the file is not media', async () => {
      const notMedia = join(workDir, 'not-a-video.mp4');
      writeFileSync(notMedia, 'this is plain text, not a video');

      await expect(probe(notMedia)).rejects.toThrow(FfmpegError);
    });

    it('should reject when the file does not exist', async () => {
      await expect(probe(join(workDir, 'missing.mp4'))).rejects.toThrow(
        FfmpegError,
      );
    });
  });

  describe('extractThumbnail', () => {
    it('should produce a readable JPEG scaled to 1280 wide', async () => {
      const output = join(workDir, 'thumb.jpg');

      await extractThumbnail(SAMPLE_VIDEO, 0.2, output);

      // O próprio ffprobe é o leitor: se o JPEG estiver corrompido ele falha.
      const thumb = await probe(output);
      const image = findVideoStream(thumb);
      expect(image!.width).toBe(1280);
      // scale=1280:-2 preserva a proporção 16:9 e mantém a altura par.
      expect(image!.height).toBe(720);
    });

    it('should write a file with JPEG magic bytes', async () => {
      const output = join(workDir, 'magic.jpg');

      await extractThumbnail(SAMPLE_VIDEO, 0.2, output);

      const bytes = readFileSync(output);
      expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    });

    it('should reject with the captured stderr when the input is not media', async () => {
      const notMedia = join(workDir, 'broken.mp4');
      writeFileSync(notMedia, 'not media either');

      await expect(
        extractThumbnail(notMedia, 0, join(workDir, 'never.jpg')),
      ).rejects.toThrow(FfmpegError);
    });
  });

  describe('error contract', () => {
    it('should carry binary name, exit code and stderr on failure', async () => {
      const missing = join(workDir, 'absent.mp4');

      const error: unknown = await probe(missing).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(FfmpegError);
      const ffmpegError = error as FfmpegError;
      expect(ffmpegError.binary).toBe('ffprobe');
      expect(ffmpegError.exitCode).not.toBe(0);
      expect(ffmpegError.message).toContain('ffprobe exited with code');
      expect(ffmpegError.stderr.length).toBeGreaterThan(0);
    });

    it('should surface a missing binary as an FfmpegError with a null exit code', async () => {
      // Caminho distinto do exit code: um binário inexistente nunca chega a
      // rodar, então o Node emite 'error' no processo em vez de 'close'.
      const error: unknown = await run('definitely-not-a-real-binary-xyz', [
        '-version',
      ]).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(FfmpegError);
      const ffmpegError = error as FfmpegError;
      expect(ffmpegError.exitCode).toBeNull();
      expect(ffmpegError.message).toContain('ENOENT');
    });
  });
});
