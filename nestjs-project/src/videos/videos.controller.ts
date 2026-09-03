import { Controller, Get, Inject, Param, Req } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  ApiExtraModels,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { OptionalAuth } from '../auth/decorators/optional-auth.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import { buildDownloadFilename } from './delivery-filename.util';
import { VideosService } from './videos.service';

interface DeliveryUrlResponse {
  url: string;
  expiresIn: number;
}

/** `request.user` e populado pelo `JwtAuthGuard` quando ha token valido. */
type MaybeAuthenticatedRequest = { user?: JwtPayload };

@ApiTags('videos')
@ApiExtraModels(ApiErrorEnvelope)
@Controller('videos')
export class VideosController {
  constructor(
    private readonly videosService: VideosService,
    private readonly storageService: StorageService,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  @Public()
  @OptionalAuth()
  @Get(':publicId/playback')
  @ApiOperation({
    summary: 'Get a presigned playback URL',
    description:
      'Returns a short-lived presigned GET URL. The client streams bytes directly from object storage, which serves HTTP Range natively, so the API is never in the byte path. Authentication is optional: anonymous callers reach any ready video, and the owner also reaches their own videos that are not ready yet.',
  })
  @ApiParam({
    name: 'publicId',
    description: 'The 11-character base62 public identifier of the video',
    example: 'dQw4w9WgXcQ',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned playback URL',
    schema: {
      properties: {
        url: { type: 'string' },
        expiresIn: { type: 'integer' },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description:
      'No video with that public identifier, or the video is not ready and the caller is not its owner. The two are deliberately indistinguishable.',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async playback(
    @Param('publicId') publicId: string,
    @Req() request: MaybeAuthenticatedRequest,
  ): Promise<DeliveryUrlResponse> {
    const video = await this.videosService.resolveForDelivery(
      publicId,
      request.user?.sub,
    );

    // `expiresIn` explicito: o default de `getSignedUrl` e 900s, que expiraria
    // no meio de uma sessao de playback (per `phase-03-videos/TD-12`).
    const expiresIn = this.config.playbackUrlTtlSeconds;
    const url = await this.storageService.presignGet(
      this.storageService.videosBucket,
      video.upload_id!,
      expiresIn,
    );

    return { url, expiresIn };
  }

  @Public()
  @OptionalAuth()
  @Get(':publicId/download')
  @ApiOperation({
    summary: 'Get a presigned download URL',
    description:
      'Returns a presigned GET URL carrying a signed Content-Disposition override, so object storage itself forces the download and names the file. Kept separate from /playback rather than parameterised, because a later phase is expected to gate the two differently.',
  })
  @ApiParam({
    name: 'publicId',
    description: 'The 11-character base62 public identifier of the video',
    example: 'dQw4w9WgXcQ',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned download URL',
    schema: {
      properties: {
        url: { type: 'string' },
        expiresIn: { type: 'integer' },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Same resource-state gating as /playback',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async download(
    @Param('publicId') publicId: string,
    @Req() request: MaybeAuthenticatedRequest,
  ): Promise<DeliveryUrlResponse> {
    const video = await this.videosService.resolveForDelivery(
      publicId,
      request.user?.sub,
    );

    const filename = buildDownloadFilename(video.title, video.source_ext);
    const expiresIn = this.config.playbackUrlTtlSeconds;

    // O override do header so vale numa requisicao assinada: a AWS o rejeita
    // como query param solto (per `phase-03-videos/TD-13`).
    const url = await this.storageService.presignGet(
      this.storageService.videosBucket,
      video.upload_id!,
      expiresIn,
      `attachment; filename="${filename}"`,
    );

    return { url, expiresIn };
  }
}
