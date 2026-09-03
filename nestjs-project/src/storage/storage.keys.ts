/**
 * Layout de chaves do object storage (per `phase-03-videos/TD-02`).
 *
 * As chaves são derivadas do `id` interno do vídeo — nunca do `public_id` —
 * para que um link compartilhado não revele nada sobre o caminho de storage.
 * São determinísticas de propósito: um job reexecutado sobrescreve o mesmo
 * objeto em vez de acumular duplicatas (per `phase-03-videos/TD-11`).
 */

/** `videos/{videoId}/source{ext}` no bucket privado. */
export const videoSourceKey = (videoId: string, ext: string): string =>
  `videos/${videoId}/source${ext}`;

/** `thumbnails/{videoId}/auto.jpg` no bucket público. */
export const videoThumbnailKey = (videoId: string): string =>
  `thumbnails/${videoId}/auto.jpg`;

/** Prefixo de todos os objetos de um vídeo no bucket privado. */
export const videoPrefix = (videoId: string): string => `videos/${videoId}/`;

/**
 * Extrai o `videoId` de uma chave de source.
 *
 * O ingest tus nomeia o upload com a própria chave de storage, então o id do
 * upload devolvido pelo protocolo carrega o `videoId` embutido — é assim que a
 * chave continua determinística mesmo com o nome sendo escolhido antes de a row
 * existir (per `phase-03-videos/TD-02`).
 */
export const parseVideoIdFromSourceKey = (key: string): string | undefined =>
  /^videos\/([^/]+)\/source/.exec(key)?.[1];
