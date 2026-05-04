import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

import { AdminOnly } from '../admin/admin-auth/decorators/admin-only.decorator';
import { RequirePermissions } from '../admin/admin-auth/decorators/require-permissions.decorator';
import { PERMISSIONS } from '../admin/permissions.catalog';
import { MediaService } from '../media/media.service';
import {
  CreateRoomEmojiDto,
  UpdateRoomEmojiDto,
} from './dto/room-emoji.dto';
import { RoomEmojiType } from './schemas/room-emoji.schema';
import { RoomEmojisService } from './room-emojis.service';

const MAX_EMOJI_BYTES = 2 * 1024 * 1024; // 2 MB — emojis are tiny.

/**
 * Admin CRUD for the room emoji catalog. Mirrors the cosmetic / banner
 * pattern: list everything (active + inactive), create / patch / soft-
 * delete, and a separate file upload endpoint that returns the
 * Cloudinary URL + publicId for the form to stash on submit.
 *
 * Reuses the existing VIP_MANAGE permission since rooms are part of the
 * core platform surface and we don't want a sprawling permission list.
 * Bump to a dedicated permission later if the moderation team grows.
 */
@Controller({ path: 'admin/room-emojis', version: '1' })
@AdminOnly()
export class RoomEmojisAdminController {
  constructor(
    private readonly emojis: RoomEmojisService,
    private readonly media: MediaService,
  ) {}

  @RequirePermissions(PERMISSIONS.VIP_VIEW)
  @Get()
  async list() {
    const items = await this.emojis.listAll();
    return { items: items.map((e) => e.toJSON()) };
  }

  @RequirePermissions(PERMISSIONS.VIP_MANAGE)
  @Post()
  async create(@Body() dto: CreateRoomEmojiDto) {
    const created = await this.emojis.create(dto);
    return { emoji: created.toJSON() };
  }

  @RequirePermissions(PERMISSIONS.VIP_MANAGE)
  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateRoomEmojiDto) {
    const updated = await this.emojis.update(id, dto);
    return { emoji: updated.toJSON() };
  }

  @RequirePermissions(PERMISSIONS.VIP_MANAGE)
  @Delete(':id')
  async delete(@Param('id') id: string) {
    await this.emojis.softDelete(id);
    return { ok: true };
  }

  /**
   * Two-stage upload — caller sends the file here, gets back
   * `{ url, publicId }`, then submits the create / update form with
   * those values stashed in `assetUrl` + `assetPublicId`. Same pattern
   * as `/admin/cosmetics/upload/preview`.
   *
   * Pass `?type=svga` to upload an SVGA binary (Cloudinary `raw`
   * resource); default is `image`.
   */
  @RequirePermissions(PERMISSIONS.VIP_MANAGE)
  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_EMOJI_BYTES } }),
  )
  async upload(
    @UploadedFile() file?: Express.Multer.File,
    @Query('type') type?: string,
  ) {
    if (!file) {
      throw new BadRequestException({
        code: 'FILE_REQUIRED',
        message: 'No file uploaded',
      });
    }
    const isSvga = type === RoomEmojiType.SVGA;
    const result = isSvga
      ? await this.media.uploadAsset(file.buffer, {
          folder: 'room-emojis',
          resourceType: 'raw',
        })
      : await this.media.uploadImage(file.buffer, {
          folder: 'room-emojis',
        });
    return {
      url: result.secure_url,
      publicId: result.public_id,
    };
  }
}
