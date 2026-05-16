import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { MediaService } from '../media/media.service';
import {
  CreateRoomDto,
  EnterRoomDto,
  KickFromRoomDto,
  SendChatDto,
  SetSeatVideoDto,
  UpdateRoomSettingsDto,
} from './dto/room.dto';
import { GiftsService } from '../gifts/gifts.service';
import { RoomKind } from './schemas/room.schema';
import { RoomsService } from './rooms.service';

/**
 * User-facing room endpoints. All write operations require auth; reads of
 * a public room snapshot are open so deeplinks (e.g. shared invite links)
 * work without forcing a login first.
 */
@Controller({ path: 'rooms', version: '1' })
export class RoomsController {
  constructor(
    private readonly rooms: RoomsService,
    private readonly gifts: GiftsService,
    private readonly media: MediaService,
  ) {}

  // ---------- Lifecycle ----------

  /**
   * Create-or-get the caller's own room. Idempotent: calling on every
   * "open Mine tab" is fine — returns the existing room if there is one.
   */
  @UseGuards(JwtAuthGuard)
  @Post()
  async createOrGet(
    @CurrentUser() current: AuthenticatedUser,
    @Body() dto: CreateRoomDto,
  ) {
    const room = await this.rooms.createOrGetOwn(current.userId, dto);
    return { room: room.toJSON() };
  }

  /** GET /rooms/me — for the Mine tab. */
  @UseGuards(JwtAuthGuard)
  @Get('me')
  async myRoom(
    @CurrentUser() current: AuthenticatedUser,
    @Query('kind') kind?: RoomKind,
  ) {
    const room = await this.rooms.getOwnRoom(current.userId, kind);
    return { room: room?.toJSON() ?? null };
  }

  /// Public list of live rooms — drives the Popular / Recent grid on the
  /// Live tab. No auth required so deep-links and not-logged-in browsing
  /// keep working.
  @Public()
  @Get()
  async listLive(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('sort') sort?: 'popular' | 'recent',
    @Query('country') country?: string,
    @Query('kind') kind?: RoomKind,
  ) {
    return this.rooms.listLive({ page, limit, sort, country, kind });
  }

  /** Public snapshot — used to render the room intro card from a deeplink. */
  @Public()
  @Get(':id')
  async snapshot(@Param('id') id: string) {
    return this.rooms.getSnapshot(id);
  }

  // ---------- Settings ----------

  @UseGuards(JwtAuthGuard)
  @Patch(':id/settings')
  async updateSettings(
    @CurrentUser() current: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateRoomSettingsDto,
  ) {
    const room = await this.rooms.updateSettings(id, current.userId, dto);
    return { room: room.toJSON() };
  }

  /// Owner-only: upload a new room cover picture. The image is sent to
  /// Cloudinary, the resulting public URL is persisted on the room, and
  /// ROOM_SETTINGS_UPDATED fires so every open client picks up the new
  /// picture without a refetch. ~5 MB max; jpeg / png / webp.
  @UseGuards(JwtAuthGuard)
  @Post(':id/cover')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 5 * 1024 * 1024 },
    }),
  )
  async uploadCover(
    @CurrentUser() current: AuthenticatedUser,
    @Param('id') id: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException({
        code: 'IMAGE_REQUIRED',
        message: 'No image uploaded',
      });
    }
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.mimetype)) {
      throw new BadRequestException({
        code: 'INVALID_IMAGE_TYPE',
        message: `Image must be one of ${allowed.join(', ')}`,
        details: { received: file.mimetype },
      });
    }
    const upload = await this.media.uploadImage(file.buffer, {
      folder: `rooms/${id}/cover`,
    });
    const room = await this.rooms.updateSettings(id, current.userId, {
      coverUrl: upload.secure_url,
    });
    return { room: room.toJSON() };
  }

  /**
   * Owner-only — reveal the room's plaintext PIN so the host can
   * re-share it from the settings sheet. Service throws Forbidden
   * for non-owners. Returns `{ password: '' }` when the room has no
   * PIN, so the client can render a "set one" affordance.
   */
  @UseGuards(JwtAuthGuard)
  @Get(':id/password')
  async revealPassword(
    @CurrentUser() current: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    const password = await this.rooms.revealPassword(id, current.userId);
    return { password };
  }

  // ---------- Enter / Leave ----------

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post(':id/enter')
  async enter(
    @CurrentUser() current: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: EnterRoomDto,
  ) {
    return this.rooms.enter(id, current.userId, dto.password);
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post(':id/leave')
  async leave(
    @CurrentUser() current: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.rooms.leave(id, current.userId);
  }

  /**
   * Per-user live duration totals — drives the profile's
   * "Live Record" page. Returns audio + video minutes for today /
   * trailing-7-day / trailing-30-day windows. Records are written
   * by `leave` so the numbers update the moment a user exits a
   * room (no batch job needed).
   */
  @UseGuards(JwtAuthGuard)
  @Get('me/live-stats')
  async myLiveStats(@CurrentUser() current: AuthenticatedUser) {
    return this.rooms.liveStatsForUser(current.userId);
  }

  /**
   * Heartbeat ping. Mobile clients call this every ~30s while the
   * VideoRoomPage is mounted. Server uses the freshness of these
   * pings to decide whether the host has silently disappeared —
   * see `RoomsCron.sweepStaleHostRooms`. Idempotent + cheap; if
   * the caller isn't actually a member of the room it's a no-op.
   */
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post(':id/heartbeat')
  async heartbeat(
    @CurrentUser() current: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.rooms.heartbeat(id, current.userId);
  }

  // ---------- Seats ----------

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post(':id/seats/:seatIndex/take')
  async takeSeat(
    @CurrentUser() current: AuthenticatedUser,
    @Param('id') id: string,
    @Param('seatIndex', ParseIntPipe) seatIndex: number,
  ) {
    return this.rooms.takeSeat(id, current.userId, seatIndex);
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post(':id/seats/:seatIndex/leave')
  async leaveSeat(
    @CurrentUser() current: AuthenticatedUser,
    @Param('id') id: string,
    @Param('seatIndex', ParseIntPipe) seatIndex: number,
  ) {
    return this.rooms.leaveSeat(id, current.userId, seatIndex);
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post(':id/seats/:seatIndex/lock')
  async lockSeat(
    @CurrentUser() current: AuthenticatedUser,
    @Param('id') id: string,
    @Param('seatIndex', ParseIntPipe) seatIndex: number,
  ) {
    return this.rooms.setSeatLocked(id, current.userId, seatIndex, true);
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post(':id/seats/:seatIndex/unlock')
  async unlockSeat(
    @CurrentUser() current: AuthenticatedUser,
    @Param('id') id: string,
    @Param('seatIndex', ParseIntPipe) seatIndex: number,
  ) {
    return this.rooms.setSeatLocked(id, current.userId, seatIndex, false);
  }

  /**
   * Mute a seat. Two modes:
   *
   *   • `force` (default) — hard mute. A seat-holder cannot self-unmute
   *     through it; only a host can lift it.
   *   • `soft`            — host nudge. The seat-holder is muted right
   *     now, but can flip their mic back on whenever they want. Only
   *     honored when a moderator mutes someone OTHER than themselves —
   *     a self-mute is always `self` regardless of `mode`.
   *
   * Body is optional so existing callers (no body) keep getting a
   * force mute, matching the pre-`soft` behaviour.
   */
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post(':id/seats/:seatIndex/mute')
  async muteSeat(
    @CurrentUser() current: AuthenticatedUser,
    @Param('id') id: string,
    @Param('seatIndex', ParseIntPipe) seatIndex: number,
    @Body() body?: { soft?: boolean },
  ) {
    const mode = body?.soft === true ? 'soft' : 'force';
    return this.rooms.setSeatMuted(id, current.userId, seatIndex, true, mode);
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post(':id/seats/:seatIndex/unmute')
  async unmuteSeat(
    @CurrentUser() current: AuthenticatedUser,
    @Param('id') id: string,
    @Param('seatIndex', ParseIntPipe) seatIndex: number,
  ) {
    return this.rooms.setSeatMuted(id, current.userId, seatIndex, false);
  }

  /**
   * Toggle a seat's video publish state. See [RoomsService.setSeatVideo]
   * for the per-mode rules — only valid on `video` rooms; rejected on
   * audio. The seat holder can toggle their own; owner/admin can
   * toggle any.
   */
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post(':id/seats/:seatIndex/video')
  async setSeatVideo(
    @CurrentUser() current: AuthenticatedUser,
    @Param('id') id: string,
    @Param('seatIndex', ParseIntPipe) seatIndex: number,
    @Body() body: SetSeatVideoDto,
  ) {
    return this.rooms.setSeatVideo(id, current.userId, seatIndex, body.on);
  }

  /** Remove a member from a seat without kicking them from the room. */
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post(':id/seats/:seatIndex/kick')
  async kickFromSeat(
    @CurrentUser() current: AuthenticatedUser,
    @Param('id') id: string,
    @Param('seatIndex', ParseIntPipe) seatIndex: number,
  ) {
    return this.rooms.kickFromSeat(id, current.userId, seatIndex);
  }

  /// Owner/admin invites a user to a specific seat. Server emits a
  /// `seat.invited` event scoped to the room — only the target's
  /// client surfaces the accept/reject prompt (filter is client-side).
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post(':id/seats/:seatIndex/invite/:userId')
  async inviteToSeat(
    @CurrentUser() current: AuthenticatedUser,
    @Param('id') id: string,
    @Param('seatIndex', ParseIntPipe) seatIndex: number,
    @Param('userId') userId: string,
  ) {
    return this.rooms.inviteToSeat(id, current.userId, seatIndex, userId);
  }

  // ---------- Call requests (host-broadcast only) ----------

  /// Viewer asks to join the host's stage as an audio caller. Body is
  /// empty — the requester is the authenticated user, the room is
  /// the path param. Idempotent: a second tap refreshes the TTL.
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post(':id/call-requests')
  async createCallRequest(
    @CurrentUser() current: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.rooms.createCallRequest(id, current.userId);
  }

  /// Host / admin lists pending call requests for the room. Used to
  /// populate the manage-calls bottom sheet's "Requests" tab.
  @UseGuards(JwtAuthGuard)
  @Get(':id/call-requests')
  async listCallRequests(
    @CurrentUser() current: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.rooms.listCallRequests(id, current.userId);
  }

  /// Host approves a pending request and routes the requester into
  /// the standard SEAT_INVITED accept flow on the given seatIndex.
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post(':id/call-requests/:requestId/approve/:seatIndex')
  async approveCallRequest(
    @CurrentUser() current: AuthenticatedUser,
    @Param('id') id: string,
    @Param('requestId') requestId: string,
    @Param('seatIndex', ParseIntPipe) seatIndex: number,
  ) {
    return this.rooms.approveCallRequest(
      id,
      current.userId,
      requestId,
      seatIndex,
    );
  }

  /// Host denies a pending request. Drops the row + emits a resolved
  /// event so the requester's client can clear local state.
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post(':id/call-requests/:requestId/deny')
  async denyCallRequest(
    @CurrentUser() current: AuthenticatedUser,
    @Param('id') id: string,
    @Param('requestId') requestId: string,
  ) {
    return this.rooms.denyCallRequest(id, current.userId, requestId);
  }

  /// Requester withdraws their own pending request.
  @UseGuards(JwtAuthGuard)
  @Delete(':id/call-requests/me')
  async cancelCallRequest(
    @CurrentUser() current: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.rooms.cancelCallRequest(id, current.userId);
  }

  // ---------- Admins ----------

  @UseGuards(JwtAuthGuard)
  @Post(':id/admins/:userId')
  async promoteAdmin(
    @CurrentUser() current: AuthenticatedUser,
    @Param('id') id: string,
    @Param('userId') userId: string,
  ) {
    return this.rooms.promoteAdmin(id, current.userId, userId);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id/admins/:userId')
  async demoteAdmin(
    @CurrentUser() current: AuthenticatedUser,
    @Param('id') id: string,
    @Param('userId') userId: string,
  ) {
    return this.rooms.demoteAdmin(id, current.userId, userId);
  }

  // ---------- Block / Kick ----------

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post(':id/block/:userId')
  async block(
    @CurrentUser() current: AuthenticatedUser,
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Body() dto: KickFromRoomDto,
  ) {
    return this.rooms.block(id, current.userId, userId, dto.reason ?? '');
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id/block/:userId')
  async unblock(
    @CurrentUser() current: AuthenticatedUser,
    @Param('id') id: string,
    @Param('userId') userId: string,
  ) {
    return this.rooms.unblock(id, current.userId, userId);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id/blocked')
  async listBlocked(
    @CurrentUser() current: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.rooms.listBlocked(id, current.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id/kick-history')
  async kickHistory(
    @CurrentUser() current: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.rooms.listKickHistory(id, current.userId);
  }

  // ---------- Chat ----------

  /** Recent chat messages (newest-first). Anyone can read; auth required
   *  to keep public scrape-bots out of room chat. */
  @UseGuards(JwtAuthGuard)
  @Get(':id/chat')
  async listChat(
    @Param('id') id: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.rooms.listChat(id, { page, limit });
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post(':id/chat')
  async sendChat(
    @CurrentUser() current: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: SendChatDto,
  ) {
    const message = await this.rooms.sendChat(id, current.userId, dto.text);
    return { message };
  }

  /** Owner / admin wipes the room's chat. Service enforces the auth
   *  check; everyone connected receives `ROOM_CHAT_CLEANED` and clears
   *  their local scrollback. */
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post(':id/chat/clean')
  async cleanChat(
    @CurrentUser() current: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.rooms.cleanChat(id, current.userId);
  }

  // ---------- Gift transaction history ----------

  /// Active member roster — drives the "Online Users" bottom sheet
  /// that opens when the user taps the room's viewer-count widget.
  /// Owner is pinned to the top regardless of join time.
  @UseGuards(JwtAuthGuard)
  @Get(':id/members')
  async listMembers(@Param('id') id: string) {
    return this.rooms.listMembers(id);
  }

  /// All gifts ever sent in this room. Anyone can read; auth required so
  /// scrapers don't enumerate the gift ledger.
  @UseGuards(JwtAuthGuard)
  @Get(':id/gifts')
  async listGifts(
    @Param('id') id: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.gifts.listForRoom(id, { page, limit });
  }

  /// Per-period gift contribution leaderboard for a room. Drives the
  /// trophy widget (daily total) + the Contribution page's three tabs
  /// (Daily / Weekly / Monthly).
  @UseGuards(JwtAuthGuard)
  @Get(':id/contributions')
  async listContributions(
    @Param('id') id: string,
    @Query('period') period?: string,
    @Query('limit') limit?: number,
  ) {
    const valid = ['daily', 'weekly', 'monthly', 'alltime'] as const;
    const p = (valid as ReadonlyArray<string>).includes(period ?? '')
      ? (period as 'daily' | 'weekly' | 'monthly' | 'alltime')
      : 'daily';
    return this.gifts.getRoomContributions(id, p, limit ?? 50);
  }
}
