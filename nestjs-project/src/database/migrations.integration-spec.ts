import { DataSource } from 'typeorm';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { CreateVideos1788146469587 } from './migrations/1788146469587-CreateVideos';
import {
  ALL_ENTITIES,
  createTestDataSource,
} from '../test/create-test-data-source';

const MANAGED_TABLES = [
  'videos',
  'users',
  'channels',
  'refresh_tokens',
  'verification_tokens',
];

describe('Database migrations (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES, {
      synchronize: false,
      migrations: [
        CreateUsersAndChannels1775687773260,
        CreateAuthTokens1777579850478,
        CreateVideos1788146469587,
      ],
    });

    await dataSource.initialize();

    // Sequencial, não Promise.all: DROP ... CASCADE em tabelas ligadas por FK
    // adquire locks em ordens diferentes quando concorrente, e o Postgres aborta
    // com "deadlock detected". Serializar é o único jeito de o teardown ser
    // determinístico à medida que o grafo de FKs cresce.
    for (const table of [...MANAGED_TABLES, 'migrations']) {
      await dataSource.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    }

    // DROP TABLE ... CASCADE NÃO derruba tipos enum — no Postgres eles são
    // objetos independentes e sobrevivem à tabela que os usava. Deixá-los para
    // trás faz o CREATE TYPE do próximo runMigrations() falhar com "type
    // already exists". Varrido dinamicamente para não virar uma lista que
    // precisa ser mantida a cada enum novo.
    await dataSource.query(`
      DO $$
      DECLARE t record;
      BEGIN
        FOR t IN
          SELECT typname FROM pg_type
          WHERE typtype = 'e' AND typnamespace = 'public'::regnamespace
        LOOP
          EXECUTE format('DROP TYPE IF EXISTS %I CASCADE', t.typname);
        END LOOP;
      END $$;
    `);
  });

  afterAll(async () => {
    // The second test undoes the last migration, leaving token tables missing.
    // Re-apply so the shared DB is fully migrated when subsequent suites run.
    await dataSource.runMigrations();
    await dataSource.destroy();
  });

  it('should apply all migrations and create all five tables', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations).toHaveLength(3);

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [MANAGED_TABLES],
    );
    const tableNames = result.map((r) => r.table_name);
    expect(tableNames).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
      'videos',
    ]);
  });

  it('should revert the last migration and remove the videos table', async () => {
    await dataSource.undoLastMigration();

    const tables = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])`,
      [['videos']],
    );
    expect(tables).toHaveLength(0);

    // down() também precisa derrubar o tipo enum, senão uma reaplicação falha
    // com "type already exists".
    const enums = await dataSource.query<{ typname: string }[]>(
      `SELECT typname FROM pg_type WHERE typname = $1`,
      ['videos_status_enum'],
    );
    expect(enums).toHaveLength(0);
  });
});
