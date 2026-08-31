import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

describe('StorageModule', () => {
  it('should compile successfully', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    expect(module).toBeDefined();
    expect(module.get(StorageService)).toBeInstanceOf(StorageService);
    await module.close();
  }, 15000);

  it('should fail to construct when the storage credentials are absent', async () => {
    const accessKey = process.env.STORAGE_ACCESS_KEY;
    const secretKey = process.env.STORAGE_SECRET_KEY;
    delete process.env.STORAGE_ACCESS_KEY;
    delete process.env.STORAGE_SECRET_KEY;

    try {
      await expect(
        Test.createTestingModule({
          imports: [
            // `ignoreEnvFile` é obrigatório aqui: sem ele o ConfigModule relê o
            // `.env` do disco e repopula `process.env`, desfazendo os deletes
            // acima antes do factory rodar.
            ConfigModule.forRoot({
              isGlobal: true,
              ignoreEnvFile: true,
              load: [storageConfig],
            }),
            StorageModule,
          ],
        }).compile(),
      ).rejects.toThrow(
        'STORAGE_ACCESS_KEY and STORAGE_SECRET_KEY must be defined',
      );
    } finally {
      if (accessKey !== undefined) process.env.STORAGE_ACCESS_KEY = accessKey;
      if (secretKey !== undefined) process.env.STORAGE_SECRET_KEY = secretKey;
    }
  }, 15000);
});
