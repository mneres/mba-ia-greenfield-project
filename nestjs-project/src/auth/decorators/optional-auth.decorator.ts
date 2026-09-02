import { SetMetadata } from '@nestjs/common';

export const IS_OPTIONAL_AUTH_KEY = 'isOptionalAuth';

/**
 * Marca uma rota que aceita autenticação sem exigi-la.
 *
 * Usada junto de `@Public()`: o `@Public()` desliga a exigência de token, e
 * este decorator faz o guard ainda assim ler um header válido e popular
 * `request.user`, de modo que o handler possa distinguir o dono do anônimo
 * (per `phase-03-videos/TD-15`).
 *
 * Sem ele, uma rota pública nunca saberia quem está chamando — e a entrega de
 * vídeos não-prontos ao próprio dono seria impossível.
 */
export const OptionalAuth = () => SetMetadata(IS_OPTIONAL_AUTH_KEY, true);
