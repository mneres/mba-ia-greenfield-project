import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  STORAGE_ACCESS_KEY: 'access-key',
  STORAGE_SECRET_KEY: 'secret-key',
};

const omit = (key: string) => {
  const rest = { ...requiredEnv } as Record<string, string>;
  delete rest[key];
  return rest;
};

const validateExactly = (env: Record<string, string>) =>
  envValidationSchema.validate(env, {
    allowUnknown: true,
    abortEarly: false,
  });

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage and queue keys', () => {
  it('should accept the full set of storage and queue keys', () => {
    const { error } = validate({
      STORAGE_ENDPOINT: 'http://minio:9000',
      STORAGE_PUBLIC_ENDPOINT: 'http://localhost:9000',
      STORAGE_REGION: 'us-east-1',
      STORAGE_VIDEOS_BUCKET: 'streamtube-videos',
      STORAGE_THUMBNAILS_BUCKET: 'streamtube-thumbnails',
      STORAGE_MAX_UPLOAD_BYTES: '10737418240',
      STORAGE_PLAYBACK_URL_TTL_SECONDS: '21600',
      UPLOAD_EXPIRATION_HOURS: '48',
      UPLOAD_MAX_CONCURRENT_PER_USER: '3',
      UPLOAD_MAX_TOTAL_BYTES_PER_USER: '53687091200',
      REDIS_HOST: 'redis',
      REDIS_PORT: '6379',
    });

    expect(error).toBeUndefined();
  });

  it('should reject a missing STORAGE_ACCESS_KEY', () => {
    const { error } = validateExactly(omit('STORAGE_ACCESS_KEY'));

    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_ACCESS_KEY');
  });

  it('should reject a missing STORAGE_SECRET_KEY', () => {
    const { error } = validateExactly(omit('STORAGE_SECRET_KEY'));

    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_SECRET_KEY');
  });

  it('should default the internal and public endpoints to distinct hosts', () => {
    const { value, error } = validate({});

    expect(error).toBeUndefined();
    expect(value.STORAGE_ENDPOINT).toBe('http://minio:9000');
    expect(value.STORAGE_PUBLIC_ENDPOINT).toBe('http://localhost:9000');
    expect(value.STORAGE_ENDPOINT).not.toBe(value.STORAGE_PUBLIC_ENDPOINT);
  });

  it('should coerce numeric limits to numbers', () => {
    const { value, error } = validate({
      STORAGE_MAX_UPLOAD_BYTES: '10737418240',
      UPLOAD_MAX_CONCURRENT_PER_USER: '3',
      REDIS_PORT: '6379',
    });

    expect(error).toBeUndefined();
    expect(value.STORAGE_MAX_UPLOAD_BYTES).toBe(10737418240);
    expect(value.UPLOAD_MAX_CONCURRENT_PER_USER).toBe(3);
    expect(value.REDIS_PORT).toBe(6379);
  });

  it('should reject a non-positive UPLOAD_MAX_CONCURRENT_PER_USER', () => {
    const { error } = validate({ UPLOAD_MAX_CONCURRENT_PER_USER: '0' });

    expect(error).toBeDefined();
    expect(error!.message).toContain('UPLOAD_MAX_CONCURRENT_PER_USER');
  });

  it('should reject a malformed STORAGE_ENDPOINT', () => {
    const { error } = validate({ STORAGE_ENDPOINT: 'not-a-uri' });

    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_ENDPOINT');
  });

  it('should apply the queue defaults pointing at the Compose service name', () => {
    const { value, error } = validate({});

    expect(error).toBeUndefined();
    expect(value.REDIS_HOST).toBe('redis');
    expect(value.REDIS_PORT).toBe(6379);
  });
});
