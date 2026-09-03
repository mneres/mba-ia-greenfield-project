import { spawn } from 'child_process';

/**
 * Wrapper tipado sobre `child_process.spawn` para os binários do sistema
 * (per `phase-03-videos/TD-09`).
 *
 * Sem biblioteca intermediária de propósito: o `fluent-ffmpeg` foi
 * descontinuado e arquivado pelo próprio autor, e o que ele agrega sobre
 * `spawn` é construção de argumentos — que aqui são fixos e conhecidos.
 */

/** Subconjunto do JSON do `ffprobe` que esta fase consome. */
export interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
  [key: string]: unknown;
}

export interface FfprobeResult {
  streams: FfprobeStream[];
  format: {
    duration?: string;
    format_name?: string;
    size?: string;
    [key: string]: unknown;
  };
}

export class FfmpegError extends Error {
  constructor(
    readonly binary: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(
      `${binary} exited with code ${exitCode ?? 'null'}: ${stderr.trim() || '(no stderr)'}`,
    );
    this.name = 'FfmpegError';
  }
}

interface RunResult {
  stdout: string;
  stderr: string;
}

/**
 * Executa um binário e resolve com sua saída, ou rejeita com o `stderr`
 * capturado.
 *
 * O `stderr` entra na mensagem porque é a única pista do que houve: um vídeo
 * corrompido e um codec ausente saem os dois como exit code 1, e a diferença
 * está no texto — que TD-11 grava em `processing_error` para o painel da
 * Fase 04.
 */
export function run(binary: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args);
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));

    // Binário ausente não emite exit code — vem como erro do próprio spawn.
    child.on('error', (err) =>
      reject(new FfmpegError(binary, null, `${err.message}\n${stderr}`)),
    );

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new FfmpegError(binary, code, stderr));
    });
  });
}

/**
 * Extrai os metadados do arquivo.
 *
 * Devolve o JSON inteiro: `duration`, `width` e `height` saem daqui para
 * colunas tipadas, e o payload completo vai para `ffprobe_metadata` em jsonb
 * (per `phase-03-videos/TD-09` Revision).
 *
 * Um arquivo sem stream de vídeo **não** é erro aqui — o `ffprobe` sai com
 * código 0 e uma lista de streams sem entrada de vídeo. Quem decide que isso
 * reprova o upload é o job, que transiciona para `failed` (TD-04).
 */
export async function probe(path: string): Promise<FfprobeResult> {
  const { stdout } = await run('ffprobe', [
    // `-v error`, não `-v quiet`: o quiet silencia também as mensagens de erro,
    // e o arquivo falharia sem nenhum diagnóstico — justamente o texto que
    // TD-11 grava em `processing_error`. O `error` cala o banner e mantém o
    // stdout do `-print_format json` limpo.
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    path,
  ]);

  return JSON.parse(stdout) as FfprobeResult;
}

/** Primeiro stream de vídeo, ou `undefined` se o arquivo não tiver nenhum. */
export function findVideoStream(
  result: FfprobeResult,
): FfprobeStream | undefined {
  return result.streams.find((stream) => stream.codec_type === 'video');
}

/**
 * Extrai um quadro como JPEG (per `phase-03-videos/TD-10`).
 *
 * `-ss` vem **antes** do `-i`: ali o seek acontece no input, saltando direto
 * para o keyframe mais próximo. Depois do `-i` o ffmpeg decodifica tudo desde
 * o início até o instante pedido, o que num arquivo de 10GB é a diferença
 * entre milissegundos e minutos.
 *
 * `scale=1280:-2` preserva a proporção e mantém a altura par, exigência do
 * subsampling de croma do JPEG.
 */
export async function extractThumbnail(
  inputPath: string,
  atSeconds: number,
  outputPath: string,
): Promise<void> {
  await run('ffmpeg', [
    '-ss',
    String(atSeconds),
    '-i',
    inputPath,
    '-frames:v',
    '1',
    '-vf',
    'scale=1280:-2',
    '-q:v',
    '3',
    '-y',
    outputPath,
  ]);
}
