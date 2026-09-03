import {
  PUBLIC_ID_ALPHABET,
  PUBLIC_ID_LENGTH,
  appendUnbiasedChars,
  generatePublicId,
} from './public-id.util';

const SAMPLE_SIZE = 10000;

// 248..255 são exatamente os bytes que `% 62` dobraria sobre os 8 primeiros
// caracteres do alfabeto.
const BIASED_BYTES = [248, 249, 250, 251, 252, 253, 254, 255];

describe('appendUnbiasedChars', () => {
  it('should map an accepted byte to its base62 position', () => {
    expect(appendUnbiasedChars([0, 1, 61], '')).toBe('AB9');
  });

  it('should wrap bytes above the alphabet length back onto it', () => {
    // 62 % 62 === 0, 63 % 62 === 1
    expect(appendUnbiasedChars([62, 63], '')).toBe('AB');
  });

  it('should drop every byte that would introduce modulo bias', () => {
    expect(appendUnbiasedChars(BIASED_BYTES, '')).toBe('');
  });

  it('should append onto a partial id and stop at the full length', () => {
    const partial = appendUnbiasedChars([...BIASED_BYTES, 0, 1, 2], '');
    expect(partial).toBe('ABC');

    expect(
      appendUnbiasedChars([3, 4, 5, 6, 7, 8, 9, 10, 11, 12], partial),
    ).toBe('ABCDEFGHIJK');
  });

  it('should ignore extra bytes once the id is already complete', () => {
    const complete = 'ABCDEFGHIJK';
    expect(appendUnbiasedChars([0, 1, 2], complete)).toBe(complete);
  });
});

describe('generatePublicId', () => {
  it('should always produce exactly 11 characters', () => {
    for (let i = 0; i < 1000; i++) {
      expect(generatePublicId()).toHaveLength(PUBLIC_ID_LENGTH);
    }
  });

  it('should only emit characters from the base62 alphabet', () => {
    const allowed = new Set(PUBLIC_ID_ALPHABET);

    for (let i = 0; i < 1000; i++) {
      for (const char of generatePublicId()) {
        expect(allowed.has(char)).toBe(true);
      }
    }
  });

  // Contraparte estatística da guarda determinística acima: sem rejeição, os 8
  // primeiros caracteres sairiam com 5/256 de chance contra 4/256 dos outros
  // 54 — 25% a mais.
  it('should distribute characters uniformly across a large sample', () => {
    const frequency = new Map<string, number>(
      [...PUBLIC_ID_ALPHABET].map((char) => [char, 0]),
    );

    for (let i = 0; i < SAMPLE_SIZE; i++) {
      for (const char of generatePublicId()) {
        frequency.set(char, frequency.get(char)! + 1);
      }
    }

    const mean = (chars: string): number =>
      [...chars].reduce((sum, char) => sum + frequency.get(char)!, 0) /
      chars.length;

    const wouldBeOverRepresented = mean(PUBLIC_ID_ALPHABET.slice(0, 8));
    const rest = mean(PUBLIC_ID_ALPHABET.slice(8));

    // ~11 desvios-padrão acima de 1.0 e ~17 abaixo do 1.25 que o viés produziria.
    expect(wouldBeOverRepresented / rest).toBeLessThan(1.1);
    expect([...frequency.values()].every((count) => count > 0)).toBe(true);
  });

  it('should not repeat an id across a large sample', () => {
    const ids = new Set<string>();
    for (let i = 0; i < SAMPLE_SIZE; i++) {
      ids.add(generatePublicId());
    }

    expect(ids.size).toBe(SAMPLE_SIZE);
  });
});
