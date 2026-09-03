import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { json } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { DomainExceptionFilter } from './common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from './common/filters/validation-exception.filter';
import { TUS_UPLOAD_PATH } from './videos/videos.constants';

/**
 * Configuração global compartilhada entre `main.ts` e os testes e2e.
 *
 * Existe para que um teste e2e exercite exatamente o mesmo pipeline da
 * produção: `Test.createTestingModule()` não executa `main.ts`, então sem isto
 * cada suíte reproduz a configuração à mão e as duas divergem em silêncio.
 *
 * A aplicação precisa ser criada com `{ bodyParser: false }` — o ingest tus lê
 * o corpo como stream bruto, e qualquer parser consumiria os bytes antes
 * (per `phase-03-videos/TD-16`).
 */
export function configureApp(app: INestApplication): void {
  const jsonParser = json();
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith(TUS_UPLOAD_PATH)) return next();
    return jsonParser(req, res, next);
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new ValidationExceptionFilter(),
  );
}
