import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { BEARER_PREFIX } from '../auth.constants';
import { JwtPayload } from '../auth.types';
import { IS_OPTIONAL_AUTH_KEY } from '../decorators/optional-auth.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string>; user: unknown }>();

    if (isPublic) {
      const isOptionalAuth = this.reflector.getAllAndOverride<boolean>(
        IS_OPTIONAL_AUTH_KEY,
        [context.getHandler(), context.getClass()],
      );
      // Modo aditivo: uma rota pública sem `@OptionalAuth()` continua passando
      // direto, exatamente como antes.
      if (isOptionalAuth) await this.populateUserIfTokenPresent(request);
      return true;
    }

    const authHeader = request.headers?.authorization;

    if (!authHeader || !authHeader.startsWith(BEARER_PREFIX)) {
      throw new UnauthorizedException();
    }

    const token = authHeader.slice(BEARER_PREFIX.length);

    try {
      const payload = await this.jwtService.verifyAsync<JwtPayload>(token);
      request.user = payload;
      return true;
    } catch {
      throw new UnauthorizedException();
    }
  }

  /**
   * Lê o token se houver, e **nunca** rejeita: header ausente, malformado ou
   * inválido deixam `request.user` indefinido, e a rota segue como anônima.
   */
  private async populateUserIfTokenPresent(request: {
    headers: Record<string, string>;
    user: unknown;
  }): Promise<void> {
    const authHeader = request.headers?.authorization;
    if (!authHeader?.startsWith(BEARER_PREFIX)) return;

    try {
      request.user = await this.jwtService.verifyAsync<JwtPayload>(
        authHeader.slice(BEARER_PREFIX.length),
      );
    } catch {
      // Token inválido numa rota pública é tratado como ausência de token.
    }
  }
}
