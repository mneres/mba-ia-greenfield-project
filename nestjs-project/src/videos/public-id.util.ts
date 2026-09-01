import { randomBytes } from 'crypto';

/**
 * Alfabeto base62 do `public_id` (per `phase-03-videos/TD-06`).
 *
 * Não usamos `nanoid`: a v6 é ESM-only e este backend compila e testa como
 * CommonJS. Fixar a linha legada `nanoid@3` seria um trade pior do que gerar
 * o id aqui, onde o projeto consegue testá-lo diretamente.
 */
export const PUBLIC_ID_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export const PUBLIC_ID_LENGTH = 11;

/**
 * 256 não é múltiplo de 62: `byte % 62` mapearia os bytes 248..255 sobre os 8
 * primeiros caracteres do alfabeto, que sairiam com frequência ~1,25x maior que
 * os outros 54. Descartar essa faixa (rejection sampling) é o que sustenta os
 * ~65 bits de entropia que TD-06 assume ao chamar a colisão de desprezível.
 */
const UNBIASED_CEILING = 256 - (256 % PUBLIC_ID_ALPHABET.length); // 248

/**
 * Consome bytes, descarta os que introduziriam viés de módulo e acumula os
 * caracteres aceitos até completar o id.
 *
 * Separada de `generatePublicId` porque é aqui que mora a lógica: o CSPRNG é a
 * fronteira, e uma função pura sobre bytes conhecidos testa a rejeição de forma
 * determinística, sem mockar `crypto`.
 */
export function appendUnbiasedChars(
  bytes: Iterable<number>,
  id: string,
): string {
  let result = id;

  for (const byte of bytes) {
    if (result.length === PUBLIC_ID_LENGTH) break;
    if (byte >= UNBIASED_CEILING) continue;
    result += PUBLIC_ID_ALPHABET[byte % PUBLIC_ID_ALPHABET.length];
  }

  return result;
}

export function generatePublicId(): string {
  let id = '';

  // Um lote por volta, não um byte por vez: ~3% dos bytes são descartados,
  // então o caso comum termina numa única chamada ao CSPRNG.
  while (id.length < PUBLIC_ID_LENGTH) {
    id = appendUnbiasedChars(randomBytes(PUBLIC_ID_LENGTH), id);
  }

  return id;
}
