import type http from 'http';
import { All, Controller, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { UploadService } from './upload.service';

/**
 * Superfície do protocolo tus 1.0.0.
 *
 * Montada como rota de controller Nest, e não como middleware Express, para que
 * o pipeline de guards continue ativo — é o `JwtAuthGuard` global que autentica,
 * não um hook do tus (per `phase-03-videos/TD-04` Revision, `TD-16`).
 *
 * `@SkipThrottle()` é obrigatório, não uma otimização: o `ThrottlerGuard` está
 * registrado como `APP_GUARD` e portanto é global, a 10 requisições por minuto.
 * A 50MB por parte, um upload de 10GB emite ~200 PATCHes e seria cortado no
 * meio. O abuso aqui é limitado pela cota de `UploadQuotaService`, que é o que
 * TD-16 escolheu justamente por um limite de taxa não conseguir distinguir um
 * upload grande legítimo de abuso.
 */
@ApiExcludeController()
@SkipThrottle()
@Controller()
export class UploadController {
  constructor(private readonly uploadService: UploadService) {}

  @All(['videos/upload', 'videos/upload/*splat'])
  async handle(
    @Req() req: http.IncomingMessage,
    @Res() res: http.ServerResponse,
  ): Promise<void> {
    await this.uploadService.handle(req, res);
  }
}
