import { randomUUID } from 'crypto';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';

export interface TestStorage {
  service: StorageService;
  /**
   * Prefixo exclusivo desta suíte. Todas as chaves gravadas por um teste devem
   * começar por ele, para que suítes concorrentes não colidam mesmo
   * compartilhando os buckets reais (per `phase-03-videos/TD-14`).
   */
  prefix: string;
  close: () => Promise<void>;
}

/**
 * Sobe um contexto Nest mínimo com o `StorageModule` real apontando para o
 * MinIO do Compose, garante os buckets e devolve um prefixo isolado.
 */
export async function createTestStorage(suite: string): Promise<TestStorage> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
      StorageModule,
    ],
  }).compile();

  // init() dispara o onModuleInit do StorageService, que cria os buckets.
  await moduleRef.init();

  const service = moduleRef.get(StorageService);

  return {
    service,
    prefix: `test/${suite}/${randomUUID()}/`,
    close: () => moduleRef.close(),
  };
}
