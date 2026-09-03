import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';

/**
 * Todas as entidades do schema, em fonte única.
 *
 * Um DataSource precisa das entidades dos **dois** lados de cada relação: uma
 * lista parcial não falha no boot, falha na primeira query com "Entity metadata
 * for X#y was not found". Registrar só `Video` não basta porque ele aponta para
 * `Channel`, que aponta para `User`.
 *
 * Vive na camada de banco, e não em `src/test/`, porque o `WorkerModule` é
 * código de produção e também precisa da lista: ele não pode contar com
 * `autoLoadEntities`, já que registra apenas o `forFeature` de que precisa.
 */
export const ALL_ENTITIES = [
  User,
  Channel,
  RefreshToken,
  VerificationToken,
  Video,
];
