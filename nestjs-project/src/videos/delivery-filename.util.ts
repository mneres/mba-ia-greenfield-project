/**
 * Deriva o nome de arquivo do download a partir do título (per `TD-13`).
 *
 * O `Content-Disposition` vai assinado dentro da URL presignada, então o valor
 * precisa sobreviver a um round trip por query string e a um header HTTP:
 * aspas e quebras de linha quebrariam o header, e barras dariam ao cliente um
 * caminho em vez de um nome.
 */
const UNSAFE_FILENAME_CHARS = /[^\p{L}\p{N} ._-]/gu;
const MAX_FILENAME_LENGTH = 100;

export function buildDownloadFilename(
  title: string,
  sourceExt: string | null,
): string {
  const base =
    title
      .replace(UNSAFE_FILENAME_CHARS, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_FILENAME_LENGTH) || 'video';

  return `${base}${sourceExt ?? ''}`;
}
