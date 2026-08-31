import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { ConfigType } from '@nestjs/config';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import databaseConfig from '../config/database.config';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

describe('VideosModule', () => {
  it('should compile successfully', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [databaseConfig] }),
        TypeOrmModule.forRootAsync({
          inject: [databaseConfig.KEY],
          useFactory: (db: ConfigType<typeof databaseConfig>) => ({
            type: 'postgres' as const,
            host: db.host,
            port: db.port,
            username: db.username,
            password: db.password,
            database: db.name,
            entities: [User, Channel, RefreshToken, VerificationToken, Video],
            synchronize: false,
          }),
        }),
        VideosModule,
      ],
    }).compile();

    expect(module).toBeDefined();
    expect(module.get(VideosService)).toBeInstanceOf(VideosService);
    await module.close();
  }, 30000);
});
