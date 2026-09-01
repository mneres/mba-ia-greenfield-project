import { randomUUID } from 'crypto';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';

export interface TestQueue<T = unknown> {
  queue: Queue<T>;
  /**
   * Nome exclusivo desta execução de suíte. Filas BullMQ são globais no Redis:
   * duas suítes na mesma fila veriam os jobs uma da outra, e o `obliterate` de
   * uma apagaria os da outra (per `phase-03-videos/TD-14`).
   */
  name: string;
  /** Apaga a fila do Redis e fecha a conexão. */
  close: () => Promise<void>;
}

/**
 * Sobe uma fila BullMQ real contra o Redis do Compose, com nome isolado.
 *
 * Só produtor: nenhum Worker é criado, então nada consome os jobs e o teste
 * consegue inspecionar o que foi enfileirado.
 */
export async function createTestQueue<T = unknown>(
  suite: string,
): Promise<TestQueue<T>> {
  const name = `test-${suite}-${randomUUID()}`;

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
      BullModule.forRootAsync({
        inject: [queueConfig.KEY],
        useFactory: (config: { host: string; port: number }) => ({
          connection: { host: config.host, port: config.port },
        }),
        extraOptions: { manualRegistration: true },
      }),
      BullModule.registerQueue({ name }),
    ],
  }).compile();

  await moduleRef.init();

  const queue = moduleRef.get<Queue<T>>(getQueueToken(name));

  return {
    queue,
    name,
    close: async () => {
      // obliterate remove os jobs; sem isso as chaves ficam no Redis do dev
      // acumulando entre execuções, já que cada suíte usa um nome novo.
      await queue.obliterate({ force: true });
      await moduleRef.close();
    },
  };
}
