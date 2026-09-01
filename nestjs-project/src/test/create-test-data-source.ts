import { DataSource, EntitySchema, MigrationInterface } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';

/**
 * Todas as entidades do schema, em fonte única.
 *
 * Uma relação inversa (`Channel.videos`) faz o TypeORM exigir a entidade do
 * outro lado no mesmo DataSource: uma lista parcial derruba o
 * `DataSource.initialize()` inteiro com "Entity metadata for X#y was not
 * found". Enquanto cada suíte mantinha sua própria cópia da lista, toda
 * entidade nova com relação inversa quebrava todas as suítes de uma vez.
 */
export const ALL_ENTITIES = [
  User,
  Channel,
  RefreshToken,
  VerificationToken,
  Video,
];

interface TestDataSourceOptions {
  synchronize?: boolean;
  migrations?: (new () => MigrationInterface)[];
}

export function createTestDataSource(
  entities: (Function | string | EntitySchema<any>)[],
  options: TestDataSourceOptions = {},
): DataSource {
  const { synchronize = true, migrations } = options;
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
