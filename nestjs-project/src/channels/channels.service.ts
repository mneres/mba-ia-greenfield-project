import { Injectable } from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';
import { appendRandomSuffix, sanitizeNickname } from './nickname.util';
import { Channel } from './entities/channel.entity';

const PG_UNIQUE_VIOLATION = '23505';
const NICKNAME_COLUMN = 'nickname';
const MAX_RETRIES = 5;

/**
 * O TypeORM copia as propriedades do erro do driver `pg` para cima do próprio
 * `QueryFailedError`, então `code` e `detail` estão acessíveis aqui — mas não
 * fazem parte do tipo declarado.
 */
type PgQueryFailedError = QueryFailedError & {
  code?: string;
  detail?: string;
};

function isPgUniqueViolationOnColumn(err: unknown, column: string): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const pgError = err as PgQueryFailedError;
  return (
    pgError.code === PG_UNIQUE_VIOLATION &&
    typeof pgError.detail === 'string' &&
    pgError.detail.includes(column)
  );
}

@Injectable()
export class ChannelsService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Resolve o canal de um usuário.
   *
   * Vive aqui, e não no módulo de vídeos, porque `Channel` é entidade deste
   * domínio — o ingest precisa do `channel_id` do dono do token, mas não deve
   * consultar a tabela de outro módulo.
   */
  async findByUserId(userId: string): Promise<Channel | null> {
    return this.dataSource
      .getRepository(Channel)
      .findOneBy({ user_id: userId });
  }

  async createChannel(userId: string, email: string): Promise<Channel> {
    const baseNickname = sanitizeNickname(email.split('@')[0]);

    return this.dataSource.transaction(async (manager) => {
      let nickname = baseNickname;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const existing = await manager.findOne(Channel, {
          where: { nickname },
        });
        if (existing) {
          nickname = appendRandomSuffix(baseNickname);
          continue;
        }

        try {
          return await manager.save(
            manager.create(Channel, {
              name: baseNickname,
              nickname,
              user_id: userId,
            }),
          );
        } catch (err) {
          if (isPgUniqueViolationOnColumn(err, NICKNAME_COLUMN)) {
            // Concurrent insert between pre-check and save — retry with new suffix
            nickname = appendRandomSuffix(baseNickname);
          } else {
            throw err;
          }
        }
      }

      throw new Error(
        'Nickname conflict could not be resolved after max retries',
      );
    });
  }
}
