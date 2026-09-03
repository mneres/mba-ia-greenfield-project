import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { IS_OPTIONAL_AUTH_KEY } from '../decorators/optional-auth.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { JwtAuthGuard } from './jwt-auth.guard';

const TEST_SECRET = 'test-secret';

const STUB_HANDLER = jest.fn();
const STUB_CLASS = class {};

function makeContext(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => STUB_HANDLER,
    getClass: () => STUB_CLASS,
  } as unknown as ExecutionContext;
}

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let jwtService: JwtService;
  let mockReflector: { getAllAndOverride: jest.Mock };

  beforeAll(async () => {
    mockReflector = { getAllAndOverride: jest.fn() };

    const module = await Test.createTestingModule({
      imports: [
        JwtModule.register({
          secret: TEST_SECRET,
          signOptions: { expiresIn: '15m' },
        }),
      ],
      providers: [
        JwtAuthGuard,
        { provide: Reflector, useValue: mockReflector },
      ],
    }).compile();

    guard = module.get(JwtAuthGuard);
    jwtService = module.get(JwtService);
  });

  beforeEach(() => {
    mockReflector.getAllAndOverride.mockReturnValue(false);
  });

  it('bypasses guard on @Public() routes', async () => {
    mockReflector.getAllAndOverride.mockReturnValue(true);
    const ctx = makeContext({ headers: {} });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('passes with a valid JWT and attaches payload to request.user', async () => {
    const token = jwtService.sign({ sub: 'user-1', email: 'a@example.com' });
    const request: Record<string, unknown> = {
      headers: { authorization: `Bearer ${token}` },
    };
    const ctx = makeContext(request);

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect((request.user as Record<string, unknown>)?.sub).toBe('user-1');
    expect((request.user as Record<string, unknown>)?.email).toBe(
      'a@example.com',
    );
  });

  it('throws UnauthorizedException when Authorization header is missing', async () => {
    const ctx = makeContext({ headers: {} });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('throws UnauthorizedException on malformed Bearer token', async () => {
    const ctx = makeContext({
      headers: { authorization: 'Bearer not-a-valid-jwt' },
    });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('throws UnauthorizedException on expired JWT', async () => {
    const expiredToken = jwtService.sign(
      { sub: 'user-1', email: 'a@example.com' },
      { expiresIn: -60 },
    );
    const ctx = makeContext({
      headers: { authorization: `Bearer ${expiredToken}` },
    });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  describe('@OptionalAuth() on a public route (TD-15)', () => {
    /**
     * O reflector responde por chave: `@Public()` desliga a exigência de token
     * e `@OptionalAuth()` pede que o header seja lido mesmo assim.
     */
    const asPublicWithOptionalAuth = (optional: boolean) =>
      mockReflector.getAllAndOverride.mockImplementation((key: string) => {
        if (key === IS_PUBLIC_KEY) return true;
        if (key === IS_OPTIONAL_AUTH_KEY) return optional;
        return undefined;
      });

    it('should populate request.user when a valid token is present', async () => {
      asPublicWithOptionalAuth(true);
      const token = await jwtService.signAsync({
        sub: 'user-1',
        email: 'a@b.com',
      });
      const request: Record<string, unknown> = {
        headers: { authorization: `Bearer ${token}` },
      };

      await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);
      expect(request.user).toMatchObject({ sub: 'user-1', email: 'a@b.com' });
    });

    it('should leave request.user undefined when no header is sent', async () => {
      asPublicWithOptionalAuth(true);
      const request: Record<string, unknown> = { headers: {} };

      await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);
      expect(request.user).toBeUndefined();
    });

    it('should not reject an invalid token — it degrades to anonymous', async () => {
      asPublicWithOptionalAuth(true);
      const request: Record<string, unknown> = {
        headers: { authorization: 'Bearer not-a-real-token' },
      };

      await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);
      expect(request.user).toBeUndefined();
    });

    it('should not reject a token signed with the wrong secret', async () => {
      asPublicWithOptionalAuth(true);
      const foreign = new JwtService({ secret: 'a-different-secret' });
      const token = await foreign.signAsync({ sub: 'user-1' });
      const request: Record<string, unknown> = {
        headers: { authorization: `Bearer ${token}` },
      };

      await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);
      expect(request.user).toBeUndefined();
    });

    it('should ignore a malformed authorization header', async () => {
      asPublicWithOptionalAuth(true);
      const request: Record<string, unknown> = {
        headers: { authorization: 'Basic dXNlcjpwYXNz' },
      };

      await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);
      expect(request.user).toBeUndefined();
    });

    it('should leave a plain public route untouched — the change is additive', async () => {
      asPublicWithOptionalAuth(false);
      const token = await jwtService.signAsync({ sub: 'user-1' });
      const request: Record<string, unknown> = {
        headers: { authorization: `Bearer ${token}` },
      };

      await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);
      // Sem `@OptionalAuth()` o guard nem olha o header, como antes.
      expect(request.user).toBeUndefined();
    });
  });
});
