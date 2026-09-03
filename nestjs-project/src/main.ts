import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import swaggerConfig from './config/swagger.config';
import { buildSwaggerDocument } from './swagger/swagger-document';
import swaggerMetadata from './metadata.js';

async function bootstrap() {
  // O ingest tus precisa do corpo como stream bruto — qualquer body parser
  // consumiria os bytes antes de o protocolo os ver (per `phase-03-videos/TD-16`).
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  configureApp(app);

  const configService = app.get(ConfigService);
  const port = configService.get<number>('app.port') ?? 3000;

  const swagger = app.get<ConfigType<typeof swaggerConfig>>(swaggerConfig.KEY);

  if (swagger.enabled) {
    await SwaggerModule.loadPluginMetadata(swaggerMetadata);
    const document = buildSwaggerDocument(app);
    SwaggerModule.setup('api/docs', app, document, {
      customSiteTitle: 'StreamTube API Docs',
      swaggerOptions: { persistAuthorization: true },
    });
  }

  await app.listen(port);
}
void bootstrap();
