import { DataSource, MigrationInterface } from 'typeorm';
import type { MixedList, EntitySchema } from 'typeorm';
import { ALL_ENTITIES } from '../database/entities';

// Reexportado para não quebrar os specs que já importam daqui; a lista
// canônica vive em `src/database/entities.ts`, que o WorkerModule também usa.
export { ALL_ENTITIES };

interface TestDataSourceOptions {
  synchronize?: boolean;
  migrations?: (new () => MigrationInterface)[];
}

/**
 * `synchronize` e `false` por padrao — as suites rodam contra o schema
 * produzido pelas migrations, nao contra um schema derivado das entidades.
 *
 * O default anterior era `true`, e foi a causa raiz de um estrago real: cada
 * spec de entidade recriava tabelas por fora do runner de migration, o banco
 * de dev acabou com as tabelas existindo e a tabela `migrations` vazia, e
 * recuperar isso custou 21 linhas de dados. Alem disso, `.claude/rules/
 * typeorm-migrations.md` proibe `synchronize: true` em qualquer ambiente.
 *
 * O efeito colateral e desejavel: como os testes leem o schema migrado, uma
 * migration faltando falha de imediato e de forma legivel, em vez de ficar
 * mascarada por um schema sintetizado na hora.
 */

export function createTestDataSource(
  entities: MixedList<string | EntitySchema | (new () => object)>,
  options: TestDataSourceOptions = {},
): DataSource {
  const { synchronize = false, migrations } = options;
  return new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST ?? 'db',
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USERNAME ?? 'streamtube',
    password: process.env.DB_PASSWORD ?? 'streamtube',
    database: process.env.DB_DATABASE ?? 'streamtube',
    entities,
    synchronize,
    ...(migrations !== undefined && { migrations, migrationsRun: false }),
  });
}

export async function cleanAllTables(dataSource: DataSource): Promise<void> {
  await dataSource.query('DELETE FROM "videos"');
  await dataSource.query('DELETE FROM "refresh_tokens"');
  await dataSource.query('DELETE FROM "verification_tokens"');
  await dataSource.query('DELETE FROM "channels"');
  await dataSource.query('DELETE FROM "users"');
}
