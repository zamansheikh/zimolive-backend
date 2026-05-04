import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';

import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SendEmojiDto } from './dto/room-emoji.dto';
import { RoomEmojisService } from './room-emojis.service';

/**
 * Public + authenticated room emoji surface.
 *
 *   • GET /room-emojis        — public catalog of active emojis.
 *   • POST /rooms/:id/emoji   — fire one over the caller's seat.
 *
 * The send endpoint is namespaced under `rooms/:id` so it groups with
 * the rest of the room actions for routing / docs purposes; the path is
 * just `/v1/rooms/:id/emoji`.
 */
@Controller({ version: '1' })
export class RoomEmojisController {
  constructor(private readonly emojis: RoomEmojisService) {}

  /** Active emoji catalog. Public so the picker can prefetch before
   *  the user takes a seat. */
  @Public()
  @Get('room-emojis')
  async list() {
    const items = await this.emojis.listActive();
    return { items: items.map((e) => e.toJSON()) };
  }

  /**
   * Fire `body.emojiId` over the caller's seat. Server validates the
   * caller is currently seated in this room and broadcasts a
   * `room.seat.emoji` realtime event. Errors:
   *   • 403 NOT_SEATED — caller isn't on a seat.
   *   • 404 EMOJI_NOT_FOUND — bad id or inactive emoji.
   */
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('rooms/:id/emoji')
  async send(
    @CurrentUser() current: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: SendEmojiDto,
  ) {
    const result = await this.emojis.sendToSeat(id, current.userId, dto.emojiId);
    return { reaction: result };
  }
}
