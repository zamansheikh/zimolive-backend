import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

import { Public } from '../../common/decorators/public.decorator';
import { AdminOnly } from '../admin/admin-auth/decorators/admin-only.decorator';
import { RequirePermissions } from '../admin/admin-auth/decorators/require-permissions.decorator';
import { PERMISSIONS } from '../admin/permissions.catalog';
import { MediaService } from '../media/media.service';
import { UpdateRocketConfigDto } from './dto/rocket.dto';
import { RocketService } from './rocket.service';

// Rocket level art. Icon = small image; animation = the launch effect
// (SVGA is the in-app standard; MP4/WebM accepted too for future use).
const MAX_ICON_BYTES = 4 * 1024 * 1024;
const MAX_ANIM_BYTES = 20 * 1024 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/**
 * Unique public_id ENDING in `.svga` for a raw Cloudinary upload, so the
 * delivered URL keeps the extension (raw uploads drop it otherwise). The
 * clients sniff SVGA off the URL, so the extension matters.
 */
function svgaPublicId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now()}-${rand}.svga`;
}

@Controller({ path: 'rocket', version: '1' })
export class RocketController {
  constructor(
    private readonly svc: RocketService,
    private readonly media: MediaService,
  ) {}

  /** Public — mobile reads the level ladder + countdown setting from
   *  here. Cached client-side; refetched on rocket page open. */
  @Public()
  @Get('config')
  async getConfig() {
    const config = await this.svc.getConfig();
    return {
      enabled: config.enabled,
      timezone: config.timezone,
      topContributionThreshold: config.topContributionThreshold,
      bannerSeconds: config.bannerSeconds,
      launchCountdownSeconds: config.launchCountdownSeconds,
      cascadeDelaySeconds: config.cascadeDelaySeconds,
      levels: config.levels,
    };
  }

  /** Today's rocket state for one room. Auth-required so the realtime
   *  scope check works. The state row is lazy-created at level 1 if
   *  no gifts have landed yet today. Includes a server-computed
   *  `nextResetAt` so the countdown clock on the page renders correctly
   *  regardless of client clock skew. */
  @Get('state/:roomId')
  async getState(@Param('roomId') roomId: string) {
    const [state, nextResetAt] = await Promise.all([
      this.svc.getStateOrThrow(roomId),
      this.svc.nextResetAt(),
    ]);
    return { state, nextResetAt: nextResetAt.toISOString() };
  }

  // -------- Admin --------

  @AdminOnly()
  @RequirePermissions(PERMISSIONS.ROCKET_VIEW)
  @Get('admin/config')
  async getAdminConfig() {
    const config = await this.svc.getConfig();
    return { config };
  }

  @AdminOnly()
  @RequirePermissions(PERMISSIONS.ROCKET_MANAGE)
  @Patch('admin/config')
  async updateAdminConfig(@Body() dto: UpdateRocketConfigDto) {
    const config = await this.svc.updateConfig(dto);
    return { config };
  }

  /**
   * Upload a rocket level's icon or launch animation to Cloudinary and
   * return its URL. The admin form stores the returned `url` into the
   * level's iconUrl / assetUrl. `kind`:
   *   • icon      — small image (PNG/JPEG/WebP/GIF).
   *   • animation — the launch effect: SVGA (the in-app player format),
   *     or MP4/WebM (uploaded as Cloudinary video for future playback).
   */
  @AdminOnly()
  @RequirePermissions(PERMISSIONS.ROCKET_MANAGE)
  @HttpCode(HttpStatus.OK)
  @Post('admin/upload/:kind')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_ANIM_BYTES } }),
  )
  async uploadAsset(
    @Param('kind') kind: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (kind !== 'icon' && kind !== 'animation') {
      throw new BadRequestException({
        code: 'INVALID_ASSET_KIND',
        message: 'kind must be "icon" or "animation"',
      });
    }
    if (!file) {
      throw new BadRequestException({
        code: 'FILE_REQUIRED',
        message: 'File required',
      });
    }

    if (kind === 'icon') {
      const iconName = (file.originalname || '').toLowerCase();
      // Icons can be animated too — an SVGA plays in the level strip /
      // overlay, otherwise a static image.
      if (iconName.endsWith('.svga')) {
        const res = await this.media.uploadAsset(file.buffer, {
          folder: 'rocket/icons',
          resourceType: 'raw',
          // Keep the `.svga` extension on the delivered URL — Cloudinary
          // raw uploads otherwise drop it, which breaks extension-based
          // SVGA detection on the clients.
          publicId: svgaPublicId('icon'),
        });
        return { url: res.secure_url, publicId: res.public_id };
      }
      if (!IMAGE_TYPES.includes(file.mimetype) || file.size > MAX_ICON_BYTES) {
        throw new BadRequestException({
          code: 'INVALID_FILE',
          message: `Icon must be an SVGA or image (${IMAGE_TYPES.join(', ')}) under 4 MB`,
        });
      }
      const res = await this.media.uploadImage(file.buffer, {
        folder: 'rocket/icons',
      });
      return { url: res.secure_url, publicId: res.public_id };
    }

    // animation — pick Cloudinary resource type by extension. SVGA is a
    // custom binary → "raw"; MP4/WebM → "video"; otherwise treat as image.
    const name = (file.originalname || '').toLowerCase();
    if (name.endsWith('.svga')) {
      const res = await this.media.uploadAsset(file.buffer, {
        folder: 'rocket/animations',
        resourceType: 'raw',
        publicId: svgaPublicId('anim'),
      });
      return { url: res.secure_url, publicId: res.public_id };
    }
    if (name.endsWith('.mp4') || name.endsWith('.webm')) {
      const res = await this.media.uploadAsset(file.buffer, {
        folder: 'rocket/animations',
        resourceType: 'video',
      });
      return { url: res.secure_url, publicId: res.public_id };
    }
    if (IMAGE_TYPES.includes(file.mimetype)) {
      const res = await this.media.uploadImage(file.buffer, {
        folder: 'rocket/animations',
      });
      return { url: res.secure_url, publicId: res.public_id };
    }
    throw new BadRequestException({
      code: 'INVALID_FILE_TYPE',
      message: 'Animation must be .svga, .mp4/.webm, or an image',
    });
  }
}
