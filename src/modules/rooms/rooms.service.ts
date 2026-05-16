import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import * as bcrypt from 'bcrypt';
import { FilterQuery, Model, Types } from 'mongoose';

import { AgoraService } from '../agora/agora.service';
import { RtcRoleDto } from '../agora/dto/agora.dto';
import { NumericIdService } from '../common/numeric-id.service';
import { CounterScope } from '../common/schemas/counter.schema';
import { CosmeticsService } from '../cosmetics/cosmetics.service';
import { FcmService } from '../fcm/fcm.service';
import { GiftsService } from '../gifts/gifts.service';
import { MagicBallService } from '../magic-ball/magic-ball.service';
import { ContentFilterService } from '../moderation/content-filter.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RealtimeEventType } from '../realtime/realtime.types';
import { SystemConfigService } from '../system-config/system-config.service';
import { User, UserDocument } from '../users/schemas/user.schema';
import { CreateRoomDto, UpdateRoomSettingsDto } from './dto/room.dto';
import {
  LiveSession,
  LiveSessionDocument,
} from './schemas/live-session.schema';
import {
  RoomChatMessage,
  RoomChatMessageDocument,
  RoomChatStatus,
} from './schemas/room-chat-message.schema';
import {
  RoomMember,
  RoomMemberDocument,
  RoomRole,
} from './schemas/room-member.schema';
import {
  CallRequest,
  CallRequestDocument,
} from './schemas/call-request.schema';
import {
  RoomSeat,
  RoomSeatDocument,
} from './schemas/room-seat.schema';
import {
  Room,
  RoomDocument,
  RoomKind,
  RoomVideoMode,
  RoomStatus,
} from './schemas/room.schema';

const PASSWORD_BCRYPT_ROUNDS = 10;

/**
 * Stable Agora channel name — `room:<numericId>` keeps the channel readable
 * in logs and lets us re-derive it from a deeplink. We use numericId rather
 * than the Mongo _id because Agora channels are 1..64 ASCII chars and the
 * numericId is smaller + opaque to user mistypes.
 */
function channelNameFor(room: RoomDocument): string {
  return `room:${room.numericId}`;
}

@Injectable()
export class RoomsService implements OnModuleInit {
  private readonly logger = new Logger(RoomsService.name);

  constructor(
    @InjectModel(Room.name) private readonly roomModel: Model<RoomDocument>,
    @InjectModel(RoomSeat.name)
    private readonly seatModel: Model<RoomSeatDocument>,
    @InjectModel(RoomMember.name)
    private readonly memberModel: Model<RoomMemberDocument>,
    @InjectModel(RoomChatMessage.name)
    private readonly chatModel: Model<RoomChatMessageDocument>,
    @InjectModel(LiveSession.name)
    private readonly liveSessionModel: Model<LiveSessionDocument>,
    @InjectModel(CallRequest.name)
    private readonly callRequestModel: Model<CallRequestDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly numericIds: NumericIdService,
    private readonly agora: AgoraService,
    private readonly realtime: RealtimeService,
    private readonly gifts: GiftsService,
    private readonly cosmetics: CosmeticsService,
    private readonly magicBall: MagicBallService,
    private readonly fcm: FcmService,
    // Content filter for room chat. Provided by ModerationModule
    // (which is @Global, so no module-level import needed). Catches
    // CSAE / self-harm / solicitation patterns before the message
    // hits the database — required for Google Play submission of
    // a live-streaming social app.
    private readonly contentFilter: ContentFilterService,
    // System-config kill switch: when `liveRequiresAgency === true`,
    // only `isHost` users can create or re-enter live rooms.
    private readonly systemConfig: SystemConfigService,
  ) {}

  /**
   * Backfill `ownerCountry` for rooms that were created before the
   * field existed. Without this, the home-page country / region
   * filter silently excludes pre-rollout rooms — even after the owner
   * sets a country, their room stays in a `''` bucket that no chip
   * matches. Fully idempotent: re-runs on every boot but only touches
   * rooms whose `ownerCountry` is missing or empty.
   *
   * Cheap once steady-state — the index on `ownerCountry` makes the
   * filter `{ownerCountry: ''}` a fast scan, and the per-room update
   * goes through a bulkWrite. Future-proofed: if a brand-new install
   * hits this, it does no work because all rooms already have a value.
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.backfillOwnerCountry();
    } catch (err) {
      this.logger.warn(
        `Room ownerCountry backfill failed: ${(err as Error).message}`,
      );
    }
  }

  private async backfillOwnerCountry(): Promise<void> {
    const stale = await this.roomModel
      .find({
        $or: [{ ownerCountry: { $exists: false } }, { ownerCountry: '' }],
      })
      .select('_id ownerId')
      .lean()
      .exec();
    if (stale.length === 0) return;

    const ownerIds = Array.from(
      new Set(stale.map((r) => r.ownerId.toString())),
    ).map((id) => new Types.ObjectId(id));
    const owners = await this.userModel
      .find({ _id: { $in: ownerIds } })
      .select('_id country')
      .lean()
      .exec();
    const countryByOwner = new Map(
      owners.map((u) => [u._id.toString(), (u.country ?? '').toUpperCase()]),
    );

    const ops = stale
      .map((r) => {
        const country = countryByOwner.get(r.ownerId.toString()) ?? '';
        if (!country) return null;
        return {
          updateOne: {
            filter: { _id: r._id },
            update: { $set: { ownerCountry: country } },
          },
        };
      })
      .filter((op) => op !== null) as Array<{
      updateOne: {
        filter: Record<string, unknown>;
        update: Record<string, unknown>;
      };
    }>;
    if (ops.length === 0) return;

    await this.roomModel.bulkWrite(ops, { ordered: false });
    this.logger.log(
      `Backfilled ownerCountry on ${ops.length} room(s) (of ${stale.length} stale).`,
    );
  }


  /**
   * Fire-and-forget FCM push for room events that the target user must
   * be able to act on even when their socket is dead (screen-off,
   * backgrounded, killed). Failures are logged, never rethrown — FCM is
   * a best-effort fallback to the realtime channel, not a primary path.
   * See docs/backend/08-background-and-push.md §3.2.
   */
  private pushToUser(
    userId: string,
    title: string,
    body: string,
    data: Record<string, string>,
  ): void {
    void this.fcm
      .sendToUser(userId, { title, body, data })
      .catch((e) =>
        this.logger.warn(
          `Room FCM fan-out failed for ${userId}: ${(e as Error).message}`,
        ),
      );
  }

  /**
   * Fire-and-forget: credit the user's Magic Ball `mic_minutes` counter
   * with the duration since they joined this seat. Called from every
   * seat-vacation path (leave / kick / displaced ghost). Never blocks
   * the seat update — a magic-ball failure should never strand a seat.
   */
  private recordSeatLeave(
    userOid: Types.ObjectId | null | undefined,
    joinedAt: Date | null | undefined,
  ): void {
    if (!userOid || !joinedAt) return;
    const seconds = Math.max(0, Math.floor((Date.now() - joinedAt.getTime()) / 1000));
    if (seconds <= 0) return;
    void this.magicBall
      .recordMicSessionSeconds(userOid.toString(), seconds)
      .catch(() => undefined);
  }

  // ============== Lifecycle ==============

  /**
   * First-time room creation. One audio room + one video room per
   * user — calling twice for the same kind returns the existing room
   * rather than 409, so the client can call this on every "open Mine
   * tab" without thinking.
   *
   * The seat shape is resolved per (kind, videoMode):
   *   • audio: micCount in [4, 15], default 8.
   *   • video / hostBroadcast: micCount forced to 3 (3 audio caller
   *     seats; owner publishes video on seat 0).
   *   • video / multiSeat: micCount in {3, 5, 8} → 4 / 6 / 9 total
   *     seats including the owner. Default 5 (6-slot room).
   */
  /**
   * Shared gate for "is this user allowed to act as a live broadcaster
   * right now?" — true when either `liveRequiresAgency` is off or the
   * user holds `isHost`. Throws ForbiddenException with `HOST_ONLY`
   * otherwise. Called from create / getOwn / enter so a non-host
   * owner can't slip back into a live session through any of those
   * paths.
   */
  private async _assertCanGoLive(userOid: Types.ObjectId): Promise<void> {
    if (!(await this.systemConfig.liveRequiresAgency())) return;
    const user = await this.userModel
      .findById(userOid)
      .select('isHost')
      .lean()
      .exec();
    if (!user?.isHost) {
      throw new ForbiddenException({
        code: 'HOST_ONLY',
        message:
          'Only hosts can go live. Become a host by joining an agency or contacting an admin.',
      });
    }
  }

  async createOrGetOwn(
    ownerId: string,
    input: CreateRoomDto,
  ): Promise<RoomDocument> {
    if (!Types.ObjectId.isValid(ownerId)) {
      throw new BadRequestException({ code: 'INVALID_USER_ID', message: 'Invalid user' });
    }
    const kind = input.kind ?? RoomKind.AUDIO;
    const ownerOid = new Types.ObjectId(ownerId);

    // Live-requires-host kill switch — blocks brand-new opens AND
    // CLOSED-room reactivations. The same helper is called from
    // `getOwnRoom` (hides existing rooms from non-host owners) and
    // `enter` (blocks the owner from re-entering to broadcast) so
    // there's no path back to being live without `isHost`.
    await this._assertCanGoLive(ownerOid);

    // Resolve videoMode + micCount per kind. Throws on illegal combos
    // so the bad-config doesn't reach disk.
    const layout = this.resolveRoomLayout(kind, input.videoMode, input.micCount);

    const existing = await this.roomModel
      .findOne({ ownerId: ownerOid, kind })
      .exec();
    if (existing) {
      if (existing.status === RoomStatus.REMOVED) {
        throw new ForbiddenException({
          code: 'ROOM_REMOVED',
          message: 'This room was removed by an admin and cannot be reopened',
        });
      }
      // Active audio room: just return it. Audio rooms are persistent
      // venues — the host doesn't pick a new layout on every "open".
      if (
        existing.status === RoomStatus.ACTIVE &&
        existing.kind === RoomKind.AUDIO
      ) {
        return existing;
      }
      // Active video room: same — let the host re-enter their own
      // active session without re-creating it. (The Live FAB always
      // opens the create sheet, but a stray duplicate request
      // shouldn't tear down a live broadcast.)
      if (
        existing.status === RoomStatus.ACTIVE &&
        existing.kind === RoomKind.VIDEO
      ) {
        return existing;
      }
      // CLOSED room — restore to ACTIVE. For audio that's a no-op
      // restore; for video we ALSO apply the freshly-picked layout
      // (videoMode + micCount) so each "go live" honours the new
      // create-sheet selection. Reseed seats so the new layout's seat
      // count is reflected — old guest seats above the new ceiling
      // are removed, and missing seats are appended.
      existing.status = RoomStatus.ACTIVE;
      if (kind === RoomKind.VIDEO) {
        existing.videoMode = layout.videoMode;
        existing.micCount = layout.micCount;
        await existing.save();
        await this.reseedSeatsForKind(existing);
      } else {
        await existing.save();
      }
      return existing;
    }

    const owner = await this.userModel
      .findById(ownerOid)
      .select('displayName username avatarUrl country')
      .exec();
    if (!owner) throw new NotFoundException('Owner not found');
    const name =
      input.name?.trim() ||
      owner.displayName?.trim() ||
      owner.username?.trim() ||
      'My Room';
    // Seed the room cover with the owner's avatar so newly-created
    // rooms have a sensible identity image immediately. Owner can
    // override later via the settings sheet's "Change Picture" row.
    const coverUrl = owner.avatarUrl?.trim() ?? '';
    // Denormalize the owner's country onto the room so the home-page
    // country / region filter can index-match without a $lookup. See
    // Room.ownerCountry doc comment for the consistency tradeoff.
    const ownerCountry = (owner.country ?? '').toUpperCase();

    const room = await this.numericIds.createWithId(CounterScope.ROOM, (numericId) =>
      this.roomModel.create({
        ownerId: ownerOid,
        ownerCountry,
        kind,
        videoMode: layout.videoMode,
        numericId,
        name,
        announcement: input.announcement?.trim() ?? '',
        coverUrl,
        micCount: layout.micCount,
        status: RoomStatus.ACTIVE,
      }),
    );

    // Seed seats: index 0 = owner, 1..micCount = guest seats.
    //
    // `videoEnabled` defaults to false everywhere. Multi-seat video
    // rooms flip it true when a user takes the seat (see takeSeat);
    // host-broadcast video rooms flip it true on seat 0 alone, when
    // the owner takes their own seat.
    const seatDocs = [
      {
        roomId: room._id,
        seatIndex: 0,
        locked: false,
        muted: false,
        videoEnabled: false,
        userId: null,
      },
    ];
    for (let i = 1; i <= layout.micCount; i++) {
      seatDocs.push({
        roomId: room._id,
        seatIndex: i,
        locked: false,
        muted: false,
        videoEnabled: false,
        userId: null,
      });
    }
    await this.seatModel.insertMany(seatDocs);

    return room;
  }

  /**
   * Rebuild the seat layout to match the room's current `micCount`.
   * Used when a video room is "reopened" with a different mode/slot
   * count so the old seat layout doesn't leak through. Idempotent:
   * existing seats within [0..micCount] are reset (vacated + unmuted
   * + video off + unlocked) rather than dropped, so any seat id that
   * happens to be referenced elsewhere stays valid.
   */
  private async reseedSeatsForKind(room: RoomDocument): Promise<void> {
    // Reset every kept seat to a clean state.
    await this.seatModel
      .updateMany(
        { roomId: room._id, seatIndex: { $lte: room.micCount } },
        {
          $set: {
            userId: null,
            joinedAt: null,
            muted: false,
            mutedBy: null,
            locked: false,
            videoEnabled: false,
          },
        },
      )
      .exec();
    // Drop seats above the new ceiling (e.g., dropping from 9 slots to 6).
    await this.seatModel
      .deleteMany({ roomId: room._id, seatIndex: { $gt: room.micCount } })
      .exec();
    // Append any missing seats so seatIndex 0..micCount is fully covered.
    const present = await this.seatModel
      .find({ roomId: room._id })
      .select('seatIndex')
      .lean()
      .exec();
    const have = new Set(present.map((s) => s.seatIndex));
    const missing: Array<Record<string, unknown>> = [];
    for (let i = 0; i <= room.micCount; i++) {
      if (!have.has(i)) {
        missing.push({
          roomId: room._id,
          seatIndex: i,
          locked: false,
          muted: false,
          videoEnabled: false,
          userId: null,
        });
      }
    }
    if (missing.length > 0) {
      await this.seatModel.insertMany(missing);
    }
  }

  /**
   * Resolve + validate the seat shape for a room being created or
   * updated. Throws [BadRequestException] on illegal (kind, videoMode,
   * micCount) combinations.
   */
  private resolveRoomLayout(
    kind: RoomKind,
    videoMode: RoomVideoMode | undefined,
    requestedMic: number | undefined,
  ): { videoMode: RoomVideoMode | null; micCount: number } {
    if (kind === RoomKind.AUDIO) {
      if (videoMode != null) {
        throw new BadRequestException({
          code: 'AUDIO_ROOM_NO_VIDEO_MODE',
          message: 'Audio rooms cannot carry a videoMode',
        });
      }
      const mic = requestedMic ?? 8;
      if (mic < 4 || mic > 15) {
        throw new BadRequestException({
          code: 'INVALID_MIC_COUNT',
          message: 'micCount for audio rooms must be 4–15',
        });
      }
      return { videoMode: null, micCount: mic };
    }
    // kind === VIDEO
    if (videoMode == null) {
      throw new BadRequestException({
        code: 'VIDEO_MODE_REQUIRED',
        message: 'videoMode is required when kind=video',
      });
    }
    if (videoMode === RoomVideoMode.HOST_BROADCAST) {
      // Host-broadcast is always 1 video host + 3 audio callers.
      // The caller's micCount is ignored if present — we override to
      // the only legal value so a stale client can't lock itself out.
      return { videoMode, micCount: 3 };
    }
    // MULTI_SEAT — owner picks 4 / 6 / 9 total seats = micCount of 3 / 5 / 8.
    const mic = requestedMic ?? 5; // default 6-slot
    if (mic !== 3 && mic !== 5 && mic !== 8) {
      throw new BadRequestException({
        code: 'INVALID_MIC_COUNT',
        message:
          'micCount for multi-seat video rooms must be 3, 5, or 8 (4 / 6 / 9 total seats)',
      });
    }
    return { videoMode, micCount: mic };
  }

  /** GET /rooms/me — the caller's own room (audio for now). */
  async getOwnRoom(ownerId: string, kind: RoomKind = RoomKind.AUDIO) {
    if (!Types.ObjectId.isValid(ownerId)) return null;
    // When `liveRequiresAgency` is on and the caller isn't a host,
    // hide their existing room from this endpoint. The mobile Mine
    // tab swaps to the "START" CTA, which then trips the same gate
    // inside `createOrGetOwn` with a clear error message. The room
    // doc itself is preserved — flipping the flag back off (or
    // promoting the user) restores access.
    const ownerOid = new Types.ObjectId(ownerId);
    if (await this.systemConfig.liveRequiresAgency()) {
      const u = await this.userModel
        .findById(ownerOid)
        .select('isHost')
        .lean()
        .exec();
      if (!u?.isHost) return null;
    }
    const room = await this.roomModel
      .findOne({ ownerId: ownerOid, kind })
      .exec();
    if (!room || room.status === RoomStatus.REMOVED) return null;
    return room;
  }

  /** Public read by id or numericId (the latter is what users type).
   *
   *  `opts.includeRemoved` opts the caller into seeing REMOVED rows —
   *  used by the admin moderation paths (snapshot / restore) so a
   *  removed room can still be inspected and brought back. The public
   *  default keeps REMOVED rooms hidden so mobile clients can't
   *  rejoin one mid-takedown. */
  async getOrThrow(
    idOrNumeric: string,
    opts?: { includeRemoved?: boolean },
  ): Promise<RoomDocument> {
    let room: RoomDocument | null = null;
    if (Types.ObjectId.isValid(idOrNumeric)) {
      room = await this.roomModel.findById(idOrNumeric).exec();
    } else if (/^\d+$/.test(idOrNumeric)) {
      room = await this.roomModel
        .findOne({ numericId: parseInt(idOrNumeric, 10) })
        .exec();
    }
    const removedHidden =
      room?.status === RoomStatus.REMOVED && !opts?.includeRemoved;
    if (!room || removedHidden) {
      throw new NotFoundException({
        code: 'ROOM_NOT_FOUND',
        message: 'Room not found',
      });
    }
    return room;
  }

  /** Returns the room hydrated with author + seats + members for the
   *  in-room screen. One round-trip; mobile client can paint from this.
   *
   *  `opts.includeRemoved` lets the admin detail page load a removed
   *  room so moderators can review the audit fields and restore it.
   *  Public callers (mobile join flow) leave this off so REMOVED → 404. */
  async getSnapshot(
    roomId: string,
    opts?: { includeRemoved?: boolean },
  ) {
    const room = await this.getOrThrow(roomId, opts);
    const [seats, members, owner, seatDiamonds] = await Promise.all([
      this.seatModel
        .find({ roomId: room._id })
        .sort({ seatIndex: 1 })
        .populate('userId', 'username displayName avatarUrl numericId level isHost')
        .exec(),
      this.memberModel
        .find({ roomId: room._id })
        .sort({ joinedAt: 1 })
        .populate('userId', 'username displayName avatarUrl numericId level isHost')
        .exec(),
      this.userModel
        .findById(room.ownerId)
        .select('username displayName avatarUrl numericId level isHost country')
        .exec(),
      // Per-receiver diamond totals scoped to this room. Drives the
      // diamond badge under each seated user. The realtime layer keeps
      // these in sync as new gifts arrive (room.gift.sent payload
      // includes the receiver's fresh total).
      this.gifts.roomDiamondTotals(room._id.toString()),
    ]);
    return {
      room: room.toJSON(),
      owner: owner?.toJSON() ?? null,
      seats: seats.map((s) => s.toJSON()),
      members: members.map((m) => m.toJSON()),
      channelName: channelNameFor(room),
      seatDiamonds,
    };
  }

  // ============== Discovery (public list) ==============

  /**
   * Live rooms — the Popular / Recent grid on the Live tab. We treat a
   * room as "live" when it's ACTIVE and currently has viewers. Sorted
   * either by popularity (viewerCount desc) or recency (liveAt desc).
   *
   * Owner + theme cosmetic are populated so the card can render thumbnail
   * + avatar in one round-trip; the catalog populate keeps each item
   * lightweight (just the fields the card needs).
   */
  async listLive(params: {
    page?: number;
    limit?: number;
    sort?: 'popular' | 'recent';
    /** Comma-separated ISO-3166 codes (e.g. "BD" or "BD,IN,NP,PK"). The
     *  mobile home page sends a single code for a country pill and the
     *  expanded list for a region pill (South Asia → BD,IN,NP,PK,LK).
     *  Empty / undefined means "no country filter". Codes are uppercased
     *  to match the indexed `ownerCountry` field. */
    country?: string;
    /**
     * Optional kind discriminator. Audio + video rooms share the same
     * Room collection, so the Party tab queries `audio` and the Live
     * tab queries `video`. Empty/undefined returns both kinds, which
     * is what the admin grid wants.
     */
    kind?: RoomKind;
  }) {
    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(50, Math.max(1, params.limit ?? 20));
    const skip = (page - 1) * limit;

    const sort: Record<string, 1 | -1> = params.sort === 'recent'
      ? { liveAt: -1 }
      : { viewerCount: -1, liveAt: -1 };

    const filter: Record<string, unknown> = {
      status: RoomStatus.ACTIVE,
      viewerCount: { $gt: 0 },
    };
    if (params.kind) {
      filter.kind = params.kind;
    }

    const countries = (params.country ?? '')
      .split(',')
      .map((c) => c.trim().toUpperCase())
      .filter((c) => c.length === 2);
    if (countries.length === 1) {
      filter.ownerCountry = countries[0];
    } else if (countries.length > 1) {
      filter.ownerCountry = { $in: countries };
    }

    const [items, total] = await Promise.all([
      this.roomModel
        .find(filter)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .populate('ownerId', 'username displayName avatarUrl numericId level isHost')
        .populate('themeCosmeticId')
        .exec(),
      this.roomModel.countDocuments(filter).exec(),
    ]);

    return {
      items: items.map((r) => r.toJSON()),
      page,
      limit,
      total,
    };
  }

  // ============== Settings (owner only) ==============

  async updateSettings(
    roomId: string,
    ownerId: string,
    input: UpdateRoomSettingsDto,
  ): Promise<RoomDocument> {
    const room = await this.assertOwner(roomId, ownerId);

    if (input.name !== undefined) room.name = input.name.trim();
    if (input.announcement !== undefined) {
      room.announcement = input.announcement.trim();
    }
    if (input.micCount !== undefined && input.micCount !== room.micCount) {
      await this.resizeSeats(room, input.micCount);
      room.micCount = input.micCount;
    }
    if (input.password !== undefined) {
      // Empty string = clear password; non-empty (4-digit PIN) = hash
      // + set. Also mirror the plaintext (select: false) so the owner
      // can re-view it from settings, and the public boolean so list
      // endpoints can advertise locked rooms without selecting the
      // hash. The DTO already validated digits-only.
      room.passwordHash =
        input.password.length === 0
          ? ''
          : await bcrypt.hash(input.password, PASSWORD_BCRYPT_ROUNDS);
      room.passwordPlain = input.password;
      room.hasPassword = input.password.length > 0;
    }
    if (input.coverUrl !== undefined) {
      room.coverUrl = input.coverUrl;
    }
    if (input.themeCosmeticId !== undefined) {
      // We only validate that it's a valid ObjectId here; ownership of the
      // cosmetic is checked at the equip endpoint in CosmeticsService when
      // the user equips it. Setting an unknown id just means the client
      // can't render it — not a security issue.
      if (input.themeCosmeticId.length === 0) {
        room.themeCosmeticId = null;
      } else if (Types.ObjectId.isValid(input.themeCosmeticId)) {
        room.themeCosmeticId = new Types.ObjectId(input.themeCosmeticId);
      } else {
        throw new BadRequestException({
          code: 'INVALID_COSMETIC_ID',
          message: 'Invalid cosmetic id',
        });
      }
    }
    if (input.policies) {
      if (input.policies.chat !== undefined) room.policies.chat = input.policies.chat;
      if (input.policies.mic !== undefined) room.policies.mic = input.policies.mic;
      if (input.policies.superMic !== undefined) {
        room.policies.superMic = input.policies.superMic;
      }
    }
    await room.save();
    // Re-read seats — when micCount changes, resizeSeats() either added
    // new empty rows or trimmed unoccupied tail rows. Audience clients
    // only see this event (the owner refetches their own snapshot), so
    // shipping the seats list in the payload is the cheapest way to
    // keep their grid honest without a separate REST round-trip.
    const seats = await this.seatModel
      .find({ roomId: room._id })
      .sort({ seatIndex: 1 })
      .populate(
        'userId',
        'username displayName avatarUrl numericId level isHost',
      )
      .exec();
    void this.realtime.emitToRoom(
      room._id.toString(),
      RealtimeEventType.ROOM_SETTINGS_UPDATED,
      {
        room: room.toJSON(),
        seats: seats.map((s) => s.toJSON()),
      },
    );
    return room;
  }

  /**
   * Owner-only "reveal my room PIN". Returns the plaintext PIN that
   * was last set via `updateSettings`, or empty string when the room
   * has no password. The plaintext is stored alongside the bcrypt hash
   * (both `select: false`) precisely for this read — the owner needs
   * to share the PIN with friends and re-checking the value is
   * cheaper than rotating it every time they forget.
   */
  async revealPassword(roomId: string, ownerId: string): Promise<string> {
    await this.assertOwner(roomId, ownerId);
    if (!Types.ObjectId.isValid(roomId)) return '';
    const doc = await this.roomModel
      .findById(roomId)
      .select('+passwordPlain')
      .exec();
    return doc?.passwordPlain ?? '';
  }

  /** Add or remove guest seats when micCount changes. Never destroys an
   *  occupied seat — bumps micCount up to keep it if needed. */
  private async resizeSeats(room: RoomDocument, newCount: number) {
    const current = await this.seatModel
      .find({ roomId: room._id })
      .sort({ seatIndex: 1 })
      .exec();
    const highestOccupied = current
      .filter((s) => s.userId != null)
      .reduce((max, s) => Math.max(max, s.seatIndex), 0);
    const safeCount = Math.max(newCount, highestOccupied);

    const existingMax = current.reduce((m, s) => Math.max(m, s.seatIndex), 0);
    if (safeCount > existingMax) {
      const docs = [];
      for (let i = existingMax + 1; i <= safeCount; i++) {
        docs.push({
          roomId: room._id,
          seatIndex: i,
          locked: false,
          muted: false,
          userId: null,
        });
      }
      await this.seatModel.insertMany(docs);
    } else if (safeCount < existingMax) {
      // Drop empty seats above the new ceiling.
      await this.seatModel
        .deleteMany({
          roomId: room._id,
          seatIndex: { $gt: safeCount },
          userId: null,
        })
        .exec();
    }
  }

  // ============== Enter / Leave (presence + token mint) ==============

  /**
   * Enter a room. Mints an Agora RTC token (subscriber by default — taking
   * a seat is a separate call that re-mints with publisher role). Creates
   * or refreshes the RoomMember presence row and bumps viewerCount.
   */
  async enter(roomId: string, userId: string, password?: string) {
    if (!Types.ObjectId.isValid(userId)) {
      throw new BadRequestException({ code: 'INVALID_USER_ID', message: 'Invalid user' });
    }
    const room = await this.getOrThrow(roomId);
    if (room.status !== RoomStatus.ACTIVE) {
      throw new ForbiddenException({
        code: 'ROOM_INACTIVE',
        message: 'Room is closed',
      });
    }
    const userOid = new Types.ObjectId(userId);

    // Owner entering their own room IS the "go live" act for both
    // audio (persistent room, owner reconnects to broadcast) and
    // video (owner publishes camera). Block when the kill switch
    // is on and they've lost host status. Guests entering a host's
    // room aren't going live themselves, so they're allowed.
    if (room.ownerId.equals(userOid)) {
      await this._assertCanGoLive(userOid);
    }

    if (room.blockedUserIds.some((b) => b.equals(userOid))) {
      throw new ForbiddenException({
        code: 'BLOCKED',
        message: 'You are blocked from this room',
      });
    }

    // Password gate. Owner + admins always bypass.
    const isPrivileged =
      room.ownerId.equals(userOid) ||
      room.adminUserIds.some((a) => a.equals(userOid));
    if (!isPrivileged) {
      const hash = await this.roomModel
        .findById(room._id)
        .select('+passwordHash')
        .lean()
        .exec();
      if (hash?.passwordHash && hash.passwordHash.length > 0) {
        if (!password) {
          throw new UnauthorizedException({
            code: 'PASSWORD_REQUIRED',
            message: 'This room requires a password',
          });
        }
        const ok = await bcrypt.compare(password, hash.passwordHash);
        if (!ok) {
          throw new UnauthorizedException({
            code: 'PASSWORD_INCORRECT',
            message: 'Incorrect room password',
          });
        }
      }
    }

    const role = this.roleFor(room, userOid);

    // Single-active-room invariant. Before joining this room, evict
    // any RoomMember rows the caller still has in OTHER rooms — e.g.
    // they tapped a global banner from room X into room Y, or signed
    // in on a second device while still in a room on the first.
    // Each auto-leave emits ROOM_MEMBER_LEFT to the prior room (so
    // its members see the user disappear) and frees any seats they
    // held there. Errors are swallowed per-room so a single broken
    // prior membership can't block the new entry.
    const priorMemberships = await this.memberModel
      .find({ userId: userOid, roomId: { $ne: room._id } })
      .select({ roomId: 1 })
      .lean()
      .exec();
    for (const prior of priorMemberships) {
      try {
        await this.leave(prior.roomId.toString(), userId);
      } catch (err: any) {
        this.logger.warn(
          `Auto-leave of prior room ${prior.roomId} failed for user ${userId}: ${err?.message ?? err}`,
        );
      }
    }

    // Upsert presence; only bump viewerCount on a true insert.
    const existing = await this.memberModel
      .findOne({ roomId: room._id, userId: userOid })
      .exec();
    let firstTimeJoin = false;
    if (existing) {
      existing.lastSeenAt = new Date();
      existing.role = role;
      await existing.save();
    } else {
      await this.memberModel.create({
        roomId: room._id,
        userId: userOid,
        role,
        joinedAt: new Date(),
        lastSeenAt: new Date(),
      });
      await this.roomModel
        .updateOne(
          { _id: room._id },
          { $inc: { viewerCount: 1 }, $set: { liveAt: new Date() } },
        )
        .exec();
      firstTimeJoin = true;
    }

    // Always notify on enter — the entry-effect overlay should fire
    // even when the joiner had a stale RoomMember row from a prior
    // session (app killed without leave, network drop, owner
    // re-entering their own room). Gating on `firstTimeJoin` made the
    // effect silently disappear for the most common test path. The
    // viewerCount in the payload still reflects truth: bumped when
    // it's a real first-time join, otherwise unchanged.
    const [joiner, equipped] = await Promise.all([
      this.userModel
        .findById(userOid)
        .select('username displayName avatarUrl numericId level isHost')
        .exec(),
      this.cosmetics.listEquippedForUsers([userId]),
    ]);
    // `equipped` is the plain JSON shape (cache-friendly) returned
    // by CosmeticsService.listEquippedForUsers. Each row's
    // `cosmeticItemId` is the inline CosmeticItem JSON, so we look
    // for the vehicle there directly.
    const vehicle = equipped
      .map((row) => row.cosmeticItemId)
      .find(
        (item): item is Record<string, unknown> =>
          !!item &&
          typeof item === 'object' &&
          (item as Record<string, unknown>).type === 'vehicle',
      );
    void this.realtime.emitToRoom(
      room._id.toString(),
      RealtimeEventType.ROOM_MEMBER_JOINED,
      {
        user: joiner?.toJSON() ?? null,
        role,
        viewerCount: room.viewerCount + (firstTimeJoin ? 1 : 0),
        // Null when the joiner doesn't own/equip a vehicle. The
        // cosmetic is fully populated (preview + animation URLs +
        // assetType) so the mobile overlay plays directly.
        vehicle: vehicle ?? null,
      },
    );

    // Mint a subscriber token by default — sufficient to listen. Taking a
    // seat re-mints with publisher role.
    const token = await this.agora.generateRtcToken({
      channelName: channelNameFor(room),
      uid: this.uidForUser(userOid),
      role: RtcRoleDto.SUBSCRIBER,
    });

    return {
      ...(await this.getSnapshot(room._id.toString())),
      myRole: role,
      rtc: token,
    };
  }

  async leave(roomId: string, userId: string): Promise<{ ok: boolean }> {
    if (!Types.ObjectId.isValid(userId)) return { ok: true };
    const room = await this.getOrThrow(roomId);
    const userOid = new Types.ObjectId(userId);

    // Grab the membership row BEFORE deleting so we can attribute
    // the time-spent to a LiveSession entry. `joinedAt` is the
    // anchor; "now" is the close. If the row isn't there (already
    // left, never properly joined), we just skip the session log.
    const membership = await this.memberModel
      .findOne({ roomId: room._id, userId: userOid })
      .select({ joinedAt: 1 })
      .lean()
      .exec();

    const removed = await this.memberModel
      .deleteOne({ roomId: room._id, userId: userOid })
      .exec();

    if (membership && membership.joinedAt && removed.deletedCount === 1) {
      const endedAt = new Date();
      const durationSec = Math.max(
        0,
        Math.floor((endedAt.getTime() - membership.joinedAt.getTime()) / 1000),
      );
      // Skip near-instant entries (<5s) so a tap-and-back doesn't
      // pollute the per-user totals with noise sessions. The Live
      // Record page only cares about meaningful time spent live.
      if (durationSec >= 5) {
        this.liveSessionModel
          .create({
            userId: userOid,
            roomId: room._id,
            roomKind: room.kind,
            durationSec,
            endedAt,
          })
          .catch((err) => {
            this.logger.warn(
              `LiveSession insert failed for user ${userId}, room ${roomId}: ${err?.message ?? err}`,
            );
          });
      }
    }
    let newViewerCount = room.viewerCount;
    if (removed.deletedCount === 1) {
      await this.roomModel
        .updateOne(
          { _id: room._id, viewerCount: { $gt: 0 } },
          { $inc: { viewerCount: -1 } },
        )
        .exec();
      newViewerCount = Math.max(0, newViewerCount - 1);
    }

    // If the user held a seat, vacate it.
    const vacated = await this.seatModel
      .find({ roomId: room._id, userId: userOid })
      .exec();
    if (vacated.length > 0) {
      await this.seatModel
        .updateMany(
          { roomId: room._id, userId: userOid },
          { $set: { userId: null, joinedAt: null, muted: false, mutedBy: null, videoEnabled: false } },
        )
        .exec();
      // Emit a SEAT_UPDATED for each freed seat so the grid empties live.
      for (const seat of vacated) {
        const fresh = await this.seatModel.findById(seat._id).exec();
        if (fresh) {
          void this.realtime.emitToRoom(
            room._id.toString(),
            RealtimeEventType.SEAT_UPDATED,
            { seat: fresh.toJSON() },
          );
        }
      }
    }

    if (removed.deletedCount === 1) {
      void this.realtime.emitToRoom(
        room._id.toString(),
        RealtimeEventType.ROOM_MEMBER_LEFT,
        { userId: userId, viewerCount: newViewerCount },
      );
    }

    // Video-room close-on-host-leave: when the room's owner leaves a
    // video room, mark the room CLOSED, emit ROOM_CLOSED to every
    // remaining member, and evict their presence rows. Mirrors the
    // typical livestream behaviour — a video room is the host's
    // session, not a persistent venue. Audio rooms are untouched
    // (they're a "venue" that stays alive when the host steps away).
    if (
      room.kind === RoomKind.VIDEO &&
      room.ownerId.equals(userOid) &&
      room.status === RoomStatus.ACTIVE
    ) {
      await this.closeVideoRoomOnHostLeave(room);
    }

    return { ok: true };
  }

  /**
   * Close a video room because the host walked away. Marks the room
   * CLOSED, evicts every remaining member's presence row, frees any
   * seats they held, and broadcasts ROOM_CLOSED so clients can pop
   * the room page.
   *
   * The room itself isn't deleted — keeping the row around preserves
   * any gift history / chat scrollback the host might browse later.
   * `createOrGetOwn` resets the room's settings on a fresh "go live"
   * so the next session picks new mode + slot count.
   */
  /**
   * Bump the caller's `lastSeenAt` on their membership row. Mobile
   * clients ping this every ~30s while a video room is mounted, so
   * the sweeper below can tell "the host walked away" from "the
   * host is fine, just quiet". No-op when the user isn't a member
   * of this room (e.g., they already left).
   */
  async heartbeat(roomId: string, userId: string): Promise<{ ok: boolean }> {
    if (!Types.ObjectId.isValid(userId) || !Types.ObjectId.isValid(roomId)) {
      return { ok: false };
    }
    await this.memberModel
      .updateOne(
        {
          roomId: new Types.ObjectId(roomId),
          userId: new Types.ObjectId(userId),
        },
        { $set: { lastSeenAt: new Date() } },
      )
      .exec();
    return { ok: true };
  }

  /**
   * Aggregate per-user live duration totals for the three windows
   * the Live Record page surfaces. Returned shape:
   * `{ today: { audioSec, videoSec }, week: {...}, month: {...} }`.
   *
   * "Today" buckets from local midnight in Asia/Dhaka (where most
   * of our users are) — falls back to UTC midnight if the runtime
   * doesn't have ICU. "Week" is the trailing 7 days, "month" the
   * trailing 30 days. We don't try to match calendar-week / month
   * boundaries — trailing windows are easier to reason about and
   * give a smoother number that doesn't reset to zero on Mondays.
   */
  async liveStatsForUser(userId: string): Promise<{
    today: { audioSec: number; videoSec: number };
    week: { audioSec: number; videoSec: number };
    month: { audioSec: number; videoSec: number };
  }> {
    if (!Types.ObjectId.isValid(userId)) {
      return {
        today: { audioSec: 0, videoSec: 0 },
        week: { audioSec: 0, videoSec: 0 },
        month: { audioSec: 0, videoSec: 0 },
      };
    }
    const userOid = new Types.ObjectId(userId);

    const now = new Date();
    const startOfTodayUtc = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const startOfWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const startOfMonth = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const rows = await this.liveSessionModel
      .aggregate<{ _id: RoomKind; sec: number }>([
        {
          $match: {
            userId: userOid,
            endedAt: { $gte: startOfMonth },
          },
        },
        {
          $facet: {
            today: [
              { $match: { endedAt: { $gte: startOfTodayUtc } } },
              { $group: { _id: '$roomKind', sec: { $sum: '$durationSec' } } },
            ],
            week: [
              { $match: { endedAt: { $gte: startOfWeek } } },
              { $group: { _id: '$roomKind', sec: { $sum: '$durationSec' } } },
            ],
            month: [
              { $group: { _id: '$roomKind', sec: { $sum: '$durationSec' } } },
            ],
          },
        },
      ])
      .exec();

    const bucket = (
      rows: Array<{ _id: RoomKind; sec: number }> | undefined,
    ) => {
      const safe = rows ?? [];
      let audioSec = 0;
      let videoSec = 0;
      for (const r of safe) {
        if (r._id === RoomKind.AUDIO) audioSec += r.sec;
        else if (r._id === RoomKind.VIDEO) videoSec += r.sec;
      }
      return { audioSec, videoSec };
    };

    const facet = rows[0] as unknown as
      | {
          today: Array<{ _id: RoomKind; sec: number }>;
          week: Array<{ _id: RoomKind; sec: number }>;
          month: Array<{ _id: RoomKind; sec: number }>;
        }
      | undefined;

    return {
      today: bucket(facet?.today),
      week: bucket(facet?.week),
      month: bucket(facet?.month),
    };
  }

  /**
   * Grace window before a video room is auto-closed because the
   * host vanished without calling `leave`. Tuned a little longer
   * than the client's 30s heartbeat cadence — a single dropped
   * ping (Wi-Fi blip, phone briefly backgrounded) shouldn't kill
   * the room, but two minutes of silence almost certainly means
   * the host's app died or they walked away.
   */
  static readonly HOST_HEARTBEAT_GRACE_MS = 2 * 60 * 1000;

  /**
   * Sweep for video rooms where the host's heartbeat has gone
   * stale and close them. Called by `RoomsCron` every 30s. Audio
   * rooms are intentionally skipped — they're "venues" that
   * survive a host stepping away, only video rooms are session-
   * scoped to the host.
   *
   * Returns the number of rooms closed so the cron can log
   * meaningful activity.
   */
  async sweepStaleHostRooms(): Promise<number> {
    const cutoff = new Date(Date.now() - RoomsService.HOST_HEARTBEAT_GRACE_MS);
    const liveVideoRooms = await this.roomModel
      .find({ kind: RoomKind.VIDEO, status: RoomStatus.ACTIVE })
      .select({ _id: 1, ownerId: 1 })
      .lean()
      .exec();
    let closed = 0;
    for (const room of liveVideoRooms) {
      const hostMember = await this.memberModel
        .findOne({ roomId: room._id, userId: room.ownerId })
        .select({ lastSeenAt: 1 })
        .lean()
        .exec();
      // Two close-worthy states: (a) host has no presence row at all
      // (they never re-joined after a crash), (b) presence row but
      // stale heartbeat past the grace window.
      const isStale =
        !hostMember ||
        !hostMember.lastSeenAt ||
        hostMember.lastSeenAt < cutoff;
      if (!isStale) continue;
      const full = await this.roomModel.findById(room._id).exec();
      if (!full) continue;
      try {
        await this.closeVideoRoomOnHostLeave(full);
        closed += 1;
      } catch (err: any) {
        this.logger.warn(
          `Auto-close failed for video room ${room._id.toString()}: ${err?.message ?? err}`,
        );
      }
    }
    return closed;
  }

  private async closeVideoRoomOnHostLeave(room: RoomDocument): Promise<void> {
    await this.roomModel
      .updateOne(
        { _id: room._id },
        { $set: { status: RoomStatus.CLOSED, viewerCount: 0 } },
      )
      .exec();
    // Evict any remaining members so a freshly-restarted room starts
    // empty. Done in a single delete; no per-row events because the
    // ROOM_CLOSED broadcast covers the same UI need.
    await this.memberModel
      .deleteMany({ roomId: room._id })
      .exec();
    // Free seats that other users were sitting on so the next session
    // doesn't inherit ghost occupants.
    await this.seatModel
      .updateMany(
        { roomId: room._id, userId: { $ne: null } },
        { $set: { userId: null, joinedAt: null, muted: false, mutedBy: null, videoEnabled: false } },
      )
      .exec();
    void this.realtime.emitToRoom(
      room._id.toString(),
      RealtimeEventType.ROOM_CLOSED,
      { reason: 'host_left' },
    );
  }

  // ============== Member listing ==============

  /**
   * Active member roster for a room — drives the "Online Users" bottom
   * sheet. Joined-most-recently first; owner row is force-pinned to the
   * top regardless of join time so the host is visually anchored. Each
   * row carries the user's display info + their level (computed from
   * the user's `experience` if your User schema tracks XP; fall back
   * to numericId-based bucket otherwise).
   */
  async listMembers(roomId: string) {
    if (!Types.ObjectId.isValid(roomId)) {
      throw new BadRequestException({
        code: 'INVALID_ROOM_ID',
        message: 'Invalid room id',
      });
    }
    const room = await this.getOrThrow(roomId);

    const members = await this.memberModel
      .find({ roomId: room._id })
      .sort({ lastSeenAt: -1 })
      .populate(
        'userId',
        'username displayName avatarUrl numericId level experience',
      )
      .lean()
      .exec();

    const items = members.map((m) => {
      const user = m.userId as unknown as {
        _id: Types.ObjectId;
        username?: string;
        displayName?: string;
        avatarUrl?: string;
        numericId?: number | null;
        level?: number | null;
        experience?: number | null;
      } | null;
      return {
        id: m._id.toString(),
        userId: user?._id.toString() ?? '',
        role: m.role,
        joinedAt: m.joinedAt,
        lastSeenAt: m.lastSeenAt,
        user: user
          ? {
              id: user._id.toString(),
              displayName: user.displayName ?? '',
              username: user.username ?? '',
              avatarUrl: user.avatarUrl ?? '',
              numericId: user.numericId ?? null,
              level: user.level ?? 1,
            }
          : null,
      };
    });

    // Pin the owner to the top — typical "host first" convention.
    items.sort((a, b) => {
      if (a.role === 'owner' && b.role !== 'owner') return -1;
      if (b.role === 'owner' && a.role !== 'owner') return 1;
      return 0;
    });

    return {
      roomId: room._id.toString(),
      total: items.length,
      items,
    };
  }

  // ============== Seat actions ==============

  /** Take a specific empty seat. Returns a fresh publisher RTC token. */
  async takeSeat(roomId: string, userId: string, seatIndex: number) {
    if (!Types.ObjectId.isValid(userId)) {
      throw new BadRequestException({ code: 'INVALID_USER_ID', message: 'Invalid user' });
    }
    const room = await this.getOrThrow(roomId);
    const userOid = new Types.ObjectId(userId);

    if (room.blockedUserIds.some((b) => b.equals(userOid))) {
      throw new ForbiddenException({ code: 'BLOCKED', message: 'You are blocked from this room' });
    }

    // Mic policy gate. Admins/owner always bypass.
    const isPrivileged =
      room.ownerId.equals(userOid) ||
      room.adminUserIds.some((a) => a.equals(userOid));
    if (!isPrivileged && room.policies.mic === 'admins') {
      throw new ForbiddenException({
        code: 'MIC_LOCKED_TO_ADMINS',
        message: 'Only admins can take a seat in this room',
      });
    }

    // The owner seat (index 0) is reserved.
    if (seatIndex === 0 && !room.ownerId.equals(userOid)) {
      throw new ForbiddenException({
        code: 'OWNER_SEAT_RESERVED',
        message: 'Only the owner can take the owner seat',
      });
    }

    // Default-video-on rules per (kind, videoMode):
    //   • audio room — always false.
    //   • video / hostBroadcast — only the owner seat (index 0)
    //     publishes video; guest seats stay audio-only.
    //   • video / multiSeat — every occupied seat publishes video by
    //     default; the seat-holder can toggle it off via setSeatVideo.
    const defaultVideoOn =
      room.kind === RoomKind.VIDEO &&
      (room.videoMode === RoomVideoMode.MULTI_SEAT ||
        (room.videoMode === RoomVideoMode.HOST_BROADCAST && seatIndex === 0));

    // Atomic claim: only flip if the seat is empty + unlocked. Conditional
    // update prevents two users grabbing the same seat in a race.
    const claim = await this.seatModel
      .findOneAndUpdate(
        {
          roomId: room._id,
          seatIndex,
          userId: null,
          locked: false,
        },
        {
          $set: {
            userId: userOid,
            joinedAt: new Date(),
            muted: false,
            mutedBy: null,
            videoEnabled: defaultVideoOn,
          },
        },
        { new: true },
      )
      .exec();
    if (!claim) {
      // Either taken, locked, or doesn't exist.
      const exists = await this.seatModel
        .findOne({ roomId: room._id, seatIndex })
        .exec();
      if (!exists) {
        throw new NotFoundException({ code: 'SEAT_NOT_FOUND', message: 'Seat not found' });
      }
      if (exists.userId) {
        throw new ConflictException({ code: 'SEAT_TAKEN', message: 'Seat already taken' });
      }
      throw new ForbiddenException({ code: 'SEAT_LOCKED', message: 'Seat is locked' });
    }

    // Vacate any other seat the user might be holding (shouldn't normally
    // happen, but guards against ghosts after a crashed leave). Track which
    // ones changed so we can emit SEAT_UPDATED for each one.
    const ghosts = await this.seatModel
      .find({
        roomId: room._id,
        userId: userOid,
        seatIndex: { $ne: seatIndex },
      })
      .exec();
    if (ghosts.length > 0) {
      await this.seatModel
        .updateMany(
          {
            roomId: room._id,
            userId: userOid,
            seatIndex: { $ne: seatIndex },
          },
          {
            $set: {
              userId: null,
              joinedAt: null,
              muted: false,
              mutedBy: null,
              videoEnabled: false,
            },
          },
        )
        .exec();
      for (const g of ghosts) {
        // Credit the elapsed time on the ghost seat to mic-minutes —
        // the user WAS on a mic from `g.joinedAt` until now, even
        // though they didn't politely leave.
        this.recordSeatLeave(g.userId, g.joinedAt);
        const fresh = await this.seatModel.findById(g._id).exec();
        if (fresh) {
          void this.realtime.emitToRoom(
            room._id.toString(),
            RealtimeEventType.SEAT_UPDATED,
            { seat: fresh.toJSON() },
          );
        }
      }
    }

    // Hydrate the seat with the new occupant for the broadcast.
    const claimWithUser = await this.seatModel
      .findById(claim._id)
      .populate('userId', 'username displayName avatarUrl numericId level isHost')
      .exec();
    void this.realtime.emitToRoom(
      room._id.toString(),
      RealtimeEventType.SEAT_UPDATED,
      { seat: (claimWithUser ?? claim).toJSON() },
    );

    // Publisher RTC token so the client can start sending audio.
    const token = await this.agora.generateRtcToken({
      channelName: channelNameFor(room),
      uid: this.uidForUser(userOid),
      role: RtcRoleDto.PUBLISHER,
    });
    return { seat: (claimWithUser ?? claim).toJSON(), rtc: token };
  }

  async leaveSeat(roomId: string, userId: string, seatIndex: number) {
    const room = await this.getOrThrow(roomId);
    const userOid = new Types.ObjectId(userId);
    // Read the pre-update doc so we can credit elapsed mic-minutes to
    // the user's Magic Ball counter — `findOneAndUpdate` below wipes
    // joinedAt as part of the same atomic op.
    const before = await this.seatModel
      .findOne({ roomId: room._id, seatIndex, userId: userOid })
      .exec();
    const res = await this.seatModel
      .findOneAndUpdate(
        { roomId: room._id, seatIndex, userId: userOid },
        { $set: { userId: null, joinedAt: null, muted: false, mutedBy: null, videoEnabled: false } },
        { new: true },
      )
      .exec();
    if (!res) {
      throw new ForbiddenException({
        code: 'NOT_SEATED',
        message: 'You are not on this seat',
      });
    }
    this.recordSeatLeave(userOid, before?.joinedAt ?? null);
    void this.realtime.emitToRoom(
      room._id.toString(),
      RealtimeEventType.SEAT_UPDATED,
      { seat: res.toJSON() },
    );
    // Remint subscriber token so the client drops publishing.
    const token = await this.agora.generateRtcToken({
      channelName: channelNameFor(room),
      uid: this.uidForUser(userOid),
      role: RtcRoleDto.SUBSCRIBER,
    });
    return { seat: res.toJSON(), rtc: token };
  }

  /** Owner/admin: lock or unlock a guest seat. Owner seat (0) is never locked. */
  async setSeatLocked(
    roomId: string,
    actorId: string,
    seatIndex: number,
    locked: boolean,
  ) {
    const room = await this.assertOwnerOrAdmin(roomId, actorId);
    if (seatIndex === 0) {
      throw new BadRequestException({
        code: 'CANNOT_LOCK_OWNER_SEAT',
        message: 'The owner seat cannot be locked',
      });
    }
    const seat = await this.seatModel
      .findOneAndUpdate(
        { roomId: room._id, seatIndex },
        { $set: { locked } },
        { new: true },
      )
      .populate('userId', 'username displayName avatarUrl numericId level isHost')
      .exec();
    if (!seat) {
      throw new NotFoundException({ code: 'SEAT_NOT_FOUND', message: 'Seat not found' });
    }
    void this.realtime.emitToRoom(
      room._id.toString(),
      RealtimeEventType.SEAT_UPDATED,
      { seat: seat.toJSON() },
    );
    return { seat: seat.toJSON() };
  }

  /**
   * Toggle a seat's mic-mute flag.
   *
   * Authorisation:
   *   • The seat-holder can mute/unmute themselves.
   *   • Owner/admin can force-mute or unmute any seat (host kill-switch).
   *
   * Previously this required owner/admin even for self-mute, which
   * meant a guest who joined the call had no way to mute their own
   * mic from the UI — they'd see a "host/admin only" error. Now it
   * mirrors `setSeatVideo`: the seat-holder is always authorised
   * for their own seat.
   *
   * Broadcasts `SEAT_UPDATED` on success so every client flips the
   * mic badge over the seat tile.
   */
  async setSeatMuted(
    roomId: string,
    actorId: string,
    seatIndex: number,
    muted: boolean,
  ) {
    if (!Types.ObjectId.isValid(actorId)) {
      throw new BadRequestException({
        code: 'INVALID_USER_ID',
        message: 'Invalid user',
      });
    }
    const room = await this.getOrThrow(roomId);
    const actorOid = new Types.ObjectId(actorId);
    const seat = await this.seatModel
      .findOne({ roomId: room._id, seatIndex })
      .exec();
    if (!seat) {
      throw new NotFoundException({
        code: 'SEAT_NOT_FOUND',
        message: 'Seat not found',
      });
    }
    if (!seat.userId) {
      throw new ForbiddenException({
        code: 'SEAT_EMPTY',
        message: 'Cannot toggle mute on an empty seat',
      });
    }

    const isOwner = room.ownerId.equals(actorOid);
    const isAdmin = room.adminUserIds.some((a) => a.equals(actorOid));
    const isSelf = seat.userId.equals(actorOid);
    if (!isOwner && !isAdmin && !isSelf) {
      throw new ForbiddenException({
        code: 'NOT_AUTHORIZED',
        message: 'Only the seat holder or room admins can toggle mute',
      });
    }

    // The rule is "did I mute my own seat, or did someone else mute
    // me". A host muting their OWN seat is still a self-mute — they
    // get to unmute themselves whenever they want. `host` only
    // applies when a moderator acts on *someone else's* seat.
    const isModerator = isOwner || isAdmin;

    // A host force-mute can only be lifted by a host. Without this
    // guard, a muted seat-holder could just re-call the endpoint as
    // themselves and the server would happily unmute them. The
    // seat-holder is exempt when THEY were the muter (mutedBy='self'),
    // and moderators bypass for everyone (so a mod can unmute the
    // user they muted).
    if (
      !muted &&
      seat.muted &&
      seat.mutedBy === 'host' &&
      !isModerator
    ) {
      throw new ForbiddenException({
        code: 'HOST_MUTED',
        message: 'You were muted by the host and cannot unmute yourself',
      });
    }

    // Decide the next `mutedBy` BEFORE the no-op short-circuit so a
    // moderator muting someone else's seat upgrades `self` → `host`
    // (which closes the unmute loophole above) even when `muted` was
    // already true.
    //
    // `isSelf` wins over `isModerator`: a host muting THEIR OWN seat is
    // a self-mute. Otherwise (a moderator acting on someone else's
    // seat) it's a host-mute. Plain users acting on their own seat
    // are obviously `self`.
    const nextMutedBy: 'self' | 'host' | null = muted
      ? isSelf
        ? 'self'
        : 'host'
      : null;

    if (seat.muted === muted && seat.mutedBy === nextMutedBy) {
      const hydrated = await this.seatModel
        .findById(seat._id)
        .populate(
          'userId',
          'username displayName avatarUrl numericId level isHost',
        )
        .exec();
      return { seat: (hydrated ?? seat).toJSON() };
    }
    seat.muted = muted;
    seat.mutedBy = nextMutedBy;
    await seat.save();
    const hydrated = await this.seatModel
      .findById(seat._id)
      .populate('userId', 'username displayName avatarUrl numericId level isHost')
      .exec();
    void this.realtime.emitToRoom(
      room._id.toString(),
      RealtimeEventType.SEAT_UPDATED,
      { seat: (hydrated ?? seat).toJSON() },
    );
    return { seat: (hydrated ?? seat).toJSON() };
  }

  /**
   * Toggle a seat's video publish state.
   *
   * Authorisation:
   *   • The seat-holder can toggle their own video.
   *   • Owner/admin can toggle any seat (host kill-switch).
   *
   * Per-mode rules:
   *   • audio room — rejected; video doesn't exist for the kind.
   *   • video / hostBroadcast — only the owner seat (index 0) can
   *     publish video. Guest seats can never enable it.
   *   • video / multiSeat — any occupied seat can toggle.
   *
   * Broadcasts `SEAT_UPDATED` on success so every client flips the
   * video tile + (un)subscribes from the seat-holder's uid.
   */
  async setSeatVideo(
    roomId: string,
    actorId: string,
    seatIndex: number,
    on: boolean,
  ) {
    if (!Types.ObjectId.isValid(actorId)) {
      throw new BadRequestException({
        code: 'INVALID_USER_ID',
        message: 'Invalid user',
      });
    }
    const room = await this.getOrThrow(roomId);
    if (room.kind !== RoomKind.VIDEO) {
      throw new BadRequestException({
        code: 'NOT_A_VIDEO_ROOM',
        message: 'Video controls are only available on video rooms',
      });
    }
    if (
      room.videoMode === RoomVideoMode.HOST_BROADCAST &&
      seatIndex !== 0
    ) {
      throw new ForbiddenException({
        code: 'HOST_BROADCAST_GUESTS_AUDIO_ONLY',
        message: 'Guest seats are audio-only in this room',
      });
    }

    const actorOid = new Types.ObjectId(actorId);
    const seat = await this.seatModel
      .findOne({ roomId: room._id, seatIndex })
      .exec();
    if (!seat) {
      throw new NotFoundException({
        code: 'SEAT_NOT_FOUND',
        message: 'Seat not found',
      });
    }
    if (!seat.userId) {
      throw new ForbiddenException({
        code: 'SEAT_EMPTY',
        message: 'Cannot toggle video on an empty seat',
      });
    }

    const isOwner = room.ownerId.equals(actorOid);
    const isAdmin = room.adminUserIds.some((a) => a.equals(actorOid));
    const isSelf = seat.userId.equals(actorOid);
    if (!isOwner && !isAdmin && !isSelf) {
      throw new ForbiddenException({
        code: 'NOT_AUTHORIZED',
        message: 'Only the seat holder or room admins can toggle video',
      });
    }

    if (seat.videoEnabled === on) {
      return { seat: seat.toJSON() };
    }
    seat.videoEnabled = on;
    await seat.save();
    const hydrated = await this.seatModel
      .findById(seat._id)
      .populate('userId', 'username displayName avatarUrl numericId level isHost')
      .exec();
    void this.realtime.emitToRoom(
      room._id.toString(),
      RealtimeEventType.SEAT_UPDATED,
      { seat: (hydrated ?? seat).toJSON() },
    );
    return { seat: (hydrated ?? seat).toJSON() };
  }

  /** Owner/admin removes a user from a seat without kicking them from the room. */
  async kickFromSeat(roomId: string, actorId: string, seatIndex: number) {
    const room = await this.assertOwnerOrAdmin(roomId, actorId);
    if (seatIndex === 0) {
      throw new BadRequestException({
        code: 'CANNOT_KICK_OWNER_SEAT',
        message: 'Owner seat cannot be vacated by an admin',
      });
    }
    // Capture pre-update occupant + joinedAt — the kick still counts
    // as completed mic time toward their Magic Ball counter.
    const before = await this.seatModel
      .findOne({ roomId: room._id, seatIndex, userId: { $ne: null } })
      .exec();
    const seat = await this.seatModel
      .findOneAndUpdate(
        { roomId: room._id, seatIndex, userId: { $ne: null } },
        { $set: { userId: null, joinedAt: null, muted: false, mutedBy: null, videoEnabled: false } },
        { new: true },
      )
      .exec();
    if (!seat) {
      throw new NotFoundException({
        code: 'SEAT_EMPTY',
        message: 'Seat is already empty',
      });
    }
    this.recordSeatLeave(before?.userId ?? null, before?.joinedAt ?? null);
    void this.realtime.emitToRoom(
      room._id.toString(),
      RealtimeEventType.SEAT_UPDATED,
      { seat: seat.toJSON() },
    );
    // Tell the kicked user out-of-band — if their socket is dead the
    // realtime event never reaches them, but the next time they look at
    // the app the FCM tray entry tells them why their mic went silent.
    // Tap routes back to the room (they're not blocked, just off the mic).
    if (before?.userId) {
      this.pushToUser(
        before.userId.toString(),
        'You were removed from a seat',
        'A host moved you off the mic.',
        {
          kind: 'room.seat.kicked',
          linkKind: 'room',
          linkValue: room._id.toString(),
          seatIndex: String(seatIndex),
        },
      );
    }
    return { seat: seat.toJSON() };
  }

  /// Owner/admin invites a user to a specific seat. The seat must be
  /// empty + unlocked, and the target must be present in the room
  /// (RoomMember). We don't reserve the seat here — the invitee accepts
  /// by calling `takeSeat` like any other user; the realtime event is
  /// purely a UI prompt. Mic policy still applies to the take, so
  /// "admins-only" rooms can't have non-admin invitees take a seat.
  ///
  /// The event is broadcast to the whole room scope; receivers filter
  /// by `targetUserId === my id` to decide whether to show the prompt.
  async inviteToSeat(
    roomId: string,
    actorId: string,
    seatIndex: number,
    targetUserId: string,
    opts?: { source?: 'manual' | 'callRequest' },
  ) {
    const room = await this.assertOwnerOrAdmin(roomId, actorId);
    if (!Types.ObjectId.isValid(targetUserId)) {
      throw new BadRequestException({
        code: 'INVALID_USER_ID',
        message: 'Invalid user',
      });
    }
    if (seatIndex === 0) {
      throw new BadRequestException({
        code: 'CANNOT_INVITE_TO_OWNER_SEAT',
        message: 'Owner seat cannot be invited',
      });
    }
    const targetOid = new Types.ObjectId(targetUserId);
    if (room.ownerId.equals(targetOid)) {
      throw new BadRequestException({
        code: 'OWNER_NEEDS_NO_INVITE',
        message: 'Owner does not need an invite',
      });
    }

    const seat = await this.seatModel
      .findOne({ roomId: room._id, seatIndex })
      .exec();
    if (!seat) {
      throw new NotFoundException({
        code: 'SEAT_NOT_FOUND',
        message: 'Seat not found',
      });
    }
    if (seat.userId) {
      throw new ConflictException({
        code: 'SEAT_TAKEN',
        message: 'Seat is already taken',
      });
    }
    if (seat.locked) {
      throw new ForbiddenException({
        code: 'SEAT_LOCKED',
        message: 'Seat is locked — unlock it before inviting',
      });
    }

    // The invitee should be in the room (as a viewer) for the prompt
    // to mean anything. If they're not present, surface a clear error
    // so the picker can grey them out.
    const isPresent = await this.memberModel
      .exists({ roomId: room._id, userId: targetOid })
      .exec();
    if (!isPresent) {
      throw new BadRequestException({
        code: 'TARGET_NOT_IN_ROOM',
        message: 'User is not currently in this room',
      });
    }

    const [inviter, target] = await Promise.all([
      this.userModel
        .findById(actorId)
        .select('username displayName avatarUrl numericId')
        .exec(),
      this.userModel
        .findById(targetOid)
        .select('username displayName avatarUrl numericId')
        .exec(),
    ]);

    void this.realtime.emitToRoom(
      room._id.toString(),
      RealtimeEventType.SEAT_INVITED,
      {
        targetUserId: targetUserId,
        seatIndex,
        inviter: inviter?.toJSON() ?? null,
        target: target?.toJSON() ?? null,
        // `source` lets the receiver tell apart a manual host-initiated
        // invite (requires accept prompt) from an invite that was
        // triggered by the receiver's own approved call request
        // (auto-accept — they already opted in).
        source: opts?.source ?? 'manual',
      },
    );

    // Mirror the invite over FCM. The realtime event already broadcasts
    // to the whole room scope and the client filters by targetUserId;
    // here we push *only* to the target so a backgrounded invitee still
    // sees the prompt instead of missing the seat slot.
    const inviterLabel =
      (inviter as unknown as { displayName?: string; username?: string } | null)
        ?.displayName ||
      (inviter as unknown as { username?: string } | null)?.username ||
      'A host';
    this.pushToUser(
      targetUserId,
      `${inviterLabel} invited you to a seat`,
      'Tap to take the mic.',
      {
        kind: 'room.seat.invited',
        linkKind: 'room',
        linkValue: room._id.toString(),
        seatIndex: String(seatIndex),
      },
    );

    return { ok: true };
  }

  // ============== Call requests (host-broadcast only) ==============

  /// TTL for a new call request — server-side cleanup happens via the
  /// `expiresAt` TTL index on the schema. UI also drops requests older
  /// than this when computing what to show, so a slow TTL sweep can't
  /// leak stale requests into the host's manage sheet.
  private static readonly CALL_REQUEST_TTL_MS = 5 * 60 * 1000;

  /// Viewer fires a call request to join the host-broadcast stage as
  /// an audio caller. Idempotent — the unique (roomId, userId) index
  /// upserts a fresh `expiresAt` for an existing pending row so the
  /// 5-minute window resets on the latest tap. The host's seat slots
  /// are still capacity-gated when they approve, so this method
  /// stays liberal about queuing requests.
  async createCallRequest(
    roomId: string,
    requesterId: string,
  ): Promise<{ request: Record<string, unknown> }> {
    const room = await this.getOrThrow(roomId);
    if (room.kind !== RoomKind.VIDEO) {
      throw new BadRequestException({
        code: 'NOT_VIDEO_ROOM',
        message: 'Call requests are only valid for video rooms',
      });
    }
    if (room.videoMode !== RoomVideoMode.HOST_BROADCAST) {
      throw new BadRequestException({
        code: 'NOT_HOST_BROADCAST',
        message: 'Call requests only apply to host-broadcast rooms',
      });
    }
    if (!Types.ObjectId.isValid(requesterId)) {
      throw new BadRequestException({
        code: 'INVALID_USER_ID',
        message: 'Invalid user',
      });
    }
    const requesterOid = new Types.ObjectId(requesterId);
    if (room.ownerId.equals(requesterOid)) {
      throw new BadRequestException({
        code: 'OWNER_CANNOT_REQUEST',
        message: 'Owner is already on stage',
      });
    }

    // Reject if the user is already seated — taking a seat already
    // gets them on the call, no request needed.
    const seated = await this.seatModel
      .exists({ roomId: room._id, userId: requesterOid })
      .exec();
    if (seated) {
      throw new ConflictException({
        code: 'ALREADY_ON_CALL',
        message: 'You are already on a seat in this room',
      });
    }

    const expiresAt = new Date(Date.now() + RoomsService.CALL_REQUEST_TTL_MS);
    const doc = await this.callRequestModel
      .findOneAndUpdate(
        { roomId: room._id, userId: requesterOid },
        { $set: { expiresAt }, $setOnInsert: { roomId: room._id, userId: requesterOid } },
        { new: true, upsert: true },
      )
      .exec();

    const requester = await this.userModel
      .findById(requesterOid)
      .select('username displayName avatarUrl numericId level')
      .exec();

    void this.realtime.emitToRoom(
      room._id.toString(),
      RealtimeEventType.CALL_REQUEST_CREATED,
      {
        ...doc.toJSON(),
        requester: requester?.toJSON() ?? null,
      },
    );

    return {
      request: { ...doc.toJSON(), requester: requester?.toJSON() ?? null },
    };
  }

  /// Host (or admin) lists pending call requests for the room. Includes
  /// requester profile fields so the manage-sheet rows render without
  /// a second roundtrip per row.
  async listCallRequests(roomId: string, actorId: string) {
    const room = await this.assertOwnerOrAdmin(roomId, actorId);
    const docs = await this.callRequestModel
      .find({ roomId: room._id, expiresAt: { $gt: new Date() } })
      .sort({ createdAt: 1 })
      .lean()
      .exec();
    const requesterIds = docs.map((d) => d.userId);
    const users = await this.userModel
      .find({ _id: { $in: requesterIds } })
      .select('username displayName avatarUrl numericId level')
      .lean()
      .exec();
    const byId = new Map(users.map((u) => [String(u._id), u]));
    const requests = docs.map((d) => ({
      id: String(d._id),
      roomId: String(d.roomId),
      userId: String(d.userId),
      expiresAt: d.expiresAt.toISOString(),
      createdAt: (d as { createdAt?: Date }).createdAt?.toISOString() ?? null,
      requester: (() => {
        const u = byId.get(String(d.userId));
        if (!u) return null;
        return {
          id: String(u._id),
          username: (u as { username?: string }).username ?? null,
          displayName: (u as { displayName?: string }).displayName ?? null,
          avatarUrl: (u as { avatarUrl?: string }).avatarUrl ?? null,
          numericId: (u as { numericId?: number }).numericId ?? null,
          level: (u as { level?: number }).level ?? null,
        };
      })(),
    }));
    return { requests };
  }

  /// Host approves a call request. Drops the request row and fires a
  /// SEAT_INVITED event for the target on the given seatIndex — same
  /// flow as a host-initiated invite, so the receiver's existing
  /// accept-invite sheet pops up. The caller picks the seat index
  /// (e.g. the first empty unlocked seat) on the client side.
  async approveCallRequest(
    roomId: string,
    actorId: string,
    requestId: string,
    seatIndex: number,
  ) {
    const room = await this.assertOwnerOrAdmin(roomId, actorId);
    if (!Types.ObjectId.isValid(requestId)) {
      throw new BadRequestException({
        code: 'INVALID_REQUEST_ID',
        message: 'Invalid request id',
      });
    }
    const reqOid = new Types.ObjectId(requestId);
    const req = await this.callRequestModel
      .findOne({ _id: reqOid, roomId: room._id })
      .exec();
    if (!req) {
      throw new NotFoundException({
        code: 'REQUEST_NOT_FOUND',
        message: 'Call request not found',
      });
    }
    if (req.expiresAt.getTime() <= Date.now()) {
      await this.callRequestModel.deleteOne({ _id: reqOid }).exec();
      throw new BadRequestException({
        code: 'REQUEST_EXPIRED',
        message: 'Call request has expired',
      });
    }
    // Hand off to inviteToSeat — it does seat-empty / seat-locked /
    // user-in-room validation already, and emits SEAT_INVITED. The
    // `callRequest` source tells the receiver's client to auto-accept
    // since they already opted in by sending the request.
    await this.inviteToSeat(
      roomId,
      actorId,
      seatIndex,
      String(req.userId),
      { source: 'callRequest' },
    );
    await this.callRequestModel.deleteOne({ _id: reqOid }).exec();
    void this.realtime.emitToRoom(
      room._id.toString(),
      RealtimeEventType.CALL_REQUEST_RESOLVED,
      {
        requestId: String(reqOid),
        roomId: room._id.toString(),
        userId: String(req.userId),
        status: 'approved',
      },
    );
    return { ok: true };
  }

  /// Host denies a call request. Just drops the row + emits a
  /// resolved event so the requester's client can clear local state.
  async denyCallRequest(
    roomId: string,
    actorId: string,
    requestId: string,
  ) {
    const room = await this.assertOwnerOrAdmin(roomId, actorId);
    if (!Types.ObjectId.isValid(requestId)) {
      throw new BadRequestException({
        code: 'INVALID_REQUEST_ID',
        message: 'Invalid request id',
      });
    }
    const reqOid = new Types.ObjectId(requestId);
    const req = await this.callRequestModel
      .findOneAndDelete({ _id: reqOid, roomId: room._id })
      .exec();
    if (!req) {
      // Already resolved/expired — return idempotent ok so the host's
      // "deny" tap doesn't surface a spurious error if the requester
      // canceled or the row TTL'd in the same tick.
      return { ok: true };
    }
    void this.realtime.emitToRoom(
      room._id.toString(),
      RealtimeEventType.CALL_REQUEST_RESOLVED,
      {
        requestId: String(reqOid),
        roomId: room._id.toString(),
        userId: String(req.userId),
        status: 'denied',
      },
    );
    return { ok: true };
  }

  /// Requester withdraws their own pending request. Same shape as deny
  /// but the row must belong to the requester (host doesn't approve).
  async cancelCallRequest(roomId: string, requesterId: string) {
    const room = await this.getOrThrow(roomId);
    if (!Types.ObjectId.isValid(requesterId)) {
      throw new BadRequestException({
        code: 'INVALID_USER_ID',
        message: 'Invalid user',
      });
    }
    const requesterOid = new Types.ObjectId(requesterId);
    const req = await this.callRequestModel
      .findOneAndDelete({ roomId: room._id, userId: requesterOid })
      .exec();
    if (!req) return { ok: true };
    void this.realtime.emitToRoom(
      room._id.toString(),
      RealtimeEventType.CALL_REQUEST_RESOLVED,
      {
        requestId: String(req._id),
        roomId: room._id.toString(),
        userId: requesterId,
        status: 'canceled',
      },
    );
    return { ok: true };
  }

  // ============== Admins / Block ==============

  async promoteAdmin(roomId: string, ownerId: string, targetUserId: string) {
    const room = await this.assertOwner(roomId, ownerId);
    if (!Types.ObjectId.isValid(targetUserId)) {
      throw new BadRequestException({ code: 'INVALID_USER_ID', message: 'Invalid user' });
    }
    const targetOid = new Types.ObjectId(targetUserId);
    if (room.ownerId.equals(targetOid)) {
      throw new BadRequestException({
        code: 'OWNER_IS_NOT_ADMIN',
        message: 'Owner is implicitly an admin',
      });
    }
    if (!room.adminUserIds.some((a) => a.equals(targetOid))) {
      room.adminUserIds.push(targetOid);
      await room.save();
    }
    // Promote the live presence record too if they're currently here.
    await this.memberModel
      .updateOne(
        { roomId: room._id, userId: targetOid },
        { $set: { role: RoomRole.ADMIN } },
      )
      .exec();
    // Broadcast the updated room so every client patches its admin
    // list live — without this the target user (and everyone else)
    // would only learn about the promotion on next room enter.
    void this.realtime.emitToRoom(
      room._id.toString(),
      RealtimeEventType.ROOM_SETTINGS_UPDATED,
      { room: room.toJSON() },
    );
    return { ok: true };
  }

  async demoteAdmin(roomId: string, ownerId: string, targetUserId: string) {
    const room = await this.assertOwner(roomId, ownerId);
    if (!Types.ObjectId.isValid(targetUserId)) return { ok: true };
    const targetOid = new Types.ObjectId(targetUserId);
    room.adminUserIds = room.adminUserIds.filter((a) => !a.equals(targetOid));
    await room.save();
    await this.memberModel
      .updateOne(
        { roomId: room._id, userId: targetOid },
        { $set: { role: RoomRole.MEMBER } },
      )
      .exec();
    // Broadcast the updated room — see `promoteAdmin` for rationale.
    void this.realtime.emitToRoom(
      room._id.toString(),
      RealtimeEventType.ROOM_SETTINGS_UPDATED,
      { room: room.toJSON() },
    );
    return { ok: true };
  }

  /**
   * Hard-kick: removes the user from the room, vacates their seat, and adds
   * them to blockedUserIds so they can't re-enter until unblocked.
   */
  async block(
    roomId: string,
    actorId: string,
    targetUserId: string,
    reason: string,
  ) {
    const room = await this.assertOwnerOrAdmin(roomId, actorId);
    if (!Types.ObjectId.isValid(targetUserId)) {
      throw new BadRequestException({ code: 'INVALID_USER_ID', message: 'Invalid user' });
    }
    const targetOid = new Types.ObjectId(targetUserId);
    if (room.ownerId.equals(targetOid)) {
      throw new BadRequestException({
        code: 'CANNOT_BLOCK_OWNER',
        message: 'Owner cannot be blocked from their own room',
      });
    }

    if (!room.blockedUserIds.some((b) => b.equals(targetOid))) {
      room.blockedUserIds.push(targetOid);
    }
    room.kickHistory.push({
      userId: targetOid,
      byUserId: new Types.ObjectId(actorId),
      reason: reason ?? '',
      at: new Date(),
    });
    await room.save();

    // Drop their presence + seats. Capture the seats they were holding so
    // we can emit SEAT_UPDATED for each one — otherwise the grid would
    // still show them sitting there until everyone refetches.
    const heldSeats = await this.seatModel
      .find({ roomId: room._id, userId: targetOid })
      .exec();
    await Promise.all([
      this.memberModel.deleteOne({ roomId: room._id, userId: targetOid }).exec(),
      this.seatModel
        .updateMany(
          { roomId: room._id, userId: targetOid },
          { $set: { userId: null, joinedAt: null, muted: false, mutedBy: null, videoEnabled: false } },
        )
        .exec(),
      this.roomModel
        .updateOne(
          { _id: room._id, viewerCount: { $gt: 0 } },
          { $inc: { viewerCount: -1 } },
        )
        .exec(),
    ]);

    // Tell every viewer in the room that this user got blocked. The target
    // listens for this event and disconnects locally on receipt; everyone
    // else just removes them from the member list.
    void this.realtime.emitToRoom(
      room._id.toString(),
      RealtimeEventType.ROOM_USER_BLOCKED,
      {
        userId: targetUserId,
        byUserId: actorId,
        reason: reason ?? '',
      },
    );
    for (const seat of heldSeats) {
      const fresh = await this.seatModel.findById(seat._id).exec();
      if (fresh) {
        void this.realtime.emitToRoom(
          room._id.toString(),
          RealtimeEventType.SEAT_UPDATED,
          { seat: fresh.toJSON() },
        );
      }
    }
    // Tell the blocked user via FCM so they evict the room session even
    // if the socket-borne event never reached them. Best-effort; the
    // server-side block is already authoritative.
    // No tap-deeplink: the user is now blocked from this room, so
    // routing them back into it would just bounce them out again.
    this.pushToUser(
      targetUserId,
      'You were removed from a room',
      reason && reason.trim().length > 0
        ? reason
        : 'A host removed you from the room.',
      {
        kind: 'room.user.blocked',
        roomId: room._id.toString(),
      },
    );
    return { ok: true };
  }

  async unblock(roomId: string, ownerId: string, targetUserId: string) {
    const room = await this.assertOwner(roomId, ownerId);
    if (!Types.ObjectId.isValid(targetUserId)) return { ok: true };
    const targetOid = new Types.ObjectId(targetUserId);
    room.blockedUserIds = room.blockedUserIds.filter((b) => !b.equals(targetOid));
    await room.save();
    return { ok: true };
  }

  async listBlocked(roomId: string, ownerId: string) {
    const room = await this.assertOwner(roomId, ownerId);
    const users = await this.userModel
      .find({ _id: { $in: room.blockedUserIds } })
      .select('username displayName avatarUrl numericId')
      .exec();
    return { items: users.map((u) => u.toJSON()) };
  }

  async listKickHistory(roomId: string, ownerId: string) {
    const room = await this.assertOwner(roomId, ownerId);
    // Hydrate the user refs in one round-trip so the admin UI gets names.
    const ids = new Set<string>();
    room.kickHistory.forEach((k) => {
      ids.add(k.userId.toString());
      ids.add(k.byUserId.toString());
    });
    const users = await this.userModel
      .find({ _id: { $in: Array.from(ids) } })
      .select('username displayName avatarUrl numericId')
      .exec();
    const byId = new Map(users.map((u) => [u._id.toString(), u.toJSON()]));
    return {
      items: room.kickHistory.map((k) => ({
        user: byId.get(k.userId.toString()) ?? null,
        by: byId.get(k.byUserId.toString()) ?? null,
        reason: k.reason,
        at: k.at,
      })),
    };
  }

  // ============== helpers ==============

  /** Compute the current role of a user wrt a room. */
  private roleFor(room: RoomDocument, userOid: Types.ObjectId): RoomRole {
    if (room.ownerId.equals(userOid)) return RoomRole.OWNER;
    if (room.adminUserIds.some((a) => a.equals(userOid))) return RoomRole.ADMIN;
    return RoomRole.MEMBER;
  }

  /**
   * Agora RTC requires a numeric uid. We derive a deterministic 31-bit
   * integer from the user's ObjectId so the same user always gets the same
   * uid in the channel — important for the realtime layer to map audio
   * publishers back to user identities.
   */
  private uidForUser(userOid: Types.ObjectId): number {
    const hex = userOid.toHexString();
    // Take the last 8 hex chars (32 bits), mask the top bit so it fits in
    // the positive int31 range Agora expects.
    const last8 = hex.slice(-8);
    return parseInt(last8, 16) & 0x7fffffff;
  }

  private async assertOwner(roomId: string, userId: string): Promise<RoomDocument> {
    const room = await this.getOrThrow(roomId);
    if (!Types.ObjectId.isValid(userId) || !room.ownerId.equals(new Types.ObjectId(userId))) {
      throw new ForbiddenException({
        code: 'NOT_OWNER',
        message: 'Only the room owner can do this',
      });
    }
    return room;
  }

  private async assertOwnerOrAdmin(
    roomId: string,
    userId: string,
  ): Promise<RoomDocument> {
    const room = await this.getOrThrow(roomId);
    if (!Types.ObjectId.isValid(userId)) {
      throw new ForbiddenException({ code: 'NOT_AUTHORIZED', message: 'Not authorized' });
    }
    const oid = new Types.ObjectId(userId);
    if (room.ownerId.equals(oid)) return room;
    if (room.adminUserIds.some((a) => a.equals(oid))) return room;
    throw new ForbiddenException({
      code: 'NOT_AUTHORIZED',
      message: 'Owner or admin only',
    });
  }

  // ============== Chat ==============

  /**
   * Recent chat messages for a room, newest-first. Used to hydrate the
   * scrollback when a viewer enters the room — live messages from then on
   * arrive via the realtime layer.
   */
  async listChat(
    roomId: string,
    params: { page?: number; limit?: number } = {},
  ) {
    const room = await this.getOrThrow(roomId);
    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(100, Math.max(1, params.limit ?? 30));
    const skip = (page - 1) * limit;
    const filter = {
      roomId: room._id,
      status: RoomChatStatus.ACTIVE,
    };
    const [items, total] = await Promise.all([
      this.chatModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('authorId', 'username displayName avatarUrl numericId level isHost')
        .exec(),
      this.chatModel.countDocuments(filter).exec(),
    ]);
    return { items: items.map((m) => m.toJSON()), page, limit, total };
  }

  /**
   * Post a chat message. Enforces the room's chat policy: when set to
   * `admins`, only the owner + admins can speak; everyone else gets a 403.
   * Blocked users always get a 403.
   *
   * On success the saved message is broadcast over the realtime layer so
   * everyone in the room sees it without polling.
   */
  async sendChat(
    roomId: string,
    authorId: string,
    text: string,
  ) {
    if (!Types.ObjectId.isValid(authorId)) {
      throw new BadRequestException({ code: 'INVALID_USER_ID', message: 'Invalid user' });
    }
    const trimmed = (text ?? '').trim();
    if (trimmed.length === 0) {
      throw new BadRequestException({
        code: 'EMPTY_MESSAGE',
        message: 'Message cannot be empty',
      });
    }
    const room = await this.getOrThrow(roomId);
    if (room.status !== RoomStatus.ACTIVE) {
      throw new ForbiddenException({
        code: 'ROOM_INACTIVE',
        message: 'Room is closed',
      });
    }
    const userOid = new Types.ObjectId(authorId);
    if (room.blockedUserIds.some((b) => b.equals(userOid))) {
      throw new ForbiddenException({
        code: 'BLOCKED',
        message: 'You are blocked from this room',
      });
    }

    const isPrivileged =
      room.ownerId.equals(userOid) ||
      room.adminUserIds.some((a) => a.equals(userOid));
    if (!isPrivileged && room.policies.chat === 'admins') {
      throw new ForbiddenException({
        code: 'CHAT_LOCKED_TO_ADMINS',
        message: 'Only admins can chat in this room',
      });
    }

    // Content filter — runs after auth/policy checks so we don't
    // burn regex on traffic that would be rejected anyway. Hard
    // categories (CSAE, self-harm, solicitation) reject the message;
    // soft hits (doxxing patterns) get masked with **** and saved
    // through. The error code intentionally doesn't reveal which
    // category fired — that info goes to the admin moderation log,
    // not back to the abuser.
    const filtered = this.contentFilter.check(trimmed);
    if (filtered.blocked) {
      throw new BadRequestException({
        code: 'MESSAGE_REJECTED',
        message:
          'Your message was blocked by our community guidelines. Please rephrase.',
      });
    }
    const finalText = filtered.text;

    const created = await this.chatModel.create({
      roomId: room._id,
      authorId: userOid,
      text: finalText,
      status: RoomChatStatus.ACTIVE,
    });
    const populated = await this.chatModel
      .findById(created._id)
      .populate('authorId', 'username displayName avatarUrl numericId level isHost')
      .exec();
    const json = populated!.toJSON();

    void this.realtime.emitToRoom(
      room._id.toString(),
      RealtimeEventType.ROOM_CHAT_MESSAGE,
      { message: json },
    );

    return json;
  }

  /**
   * Owner / admin wipes the room's chat scrollback. Bulk-marks every
   * ACTIVE message as REMOVED (so a refetch returns nothing) and emits
   * `ROOM_CHAT_CLEANED` so every connected member drops their local
   * scrollback without reloading. Idempotent — calling it on an empty
   * room is a no-op past the auth check.
   */
  async cleanChat(roomId: string, actorId: string) {
    const room = await this.assertOwnerOrAdmin(roomId, actorId);
    const actorOid = new Types.ObjectId(actorId);

    const result = await this.chatModel
      .updateMany(
        { roomId: room._id, status: RoomChatStatus.ACTIVE },
        {
          $set: {
            status: RoomChatStatus.REMOVED,
            removedBy: actorOid,
          },
        },
      )
      .exec();

    void this.realtime.emitToRoom(
      room._id.toString(),
      RealtimeEventType.ROOM_CHAT_CLEANED,
      {
        clearedBy: actorId,
        clearedAt: new Date().toISOString(),
      },
    );

    return { cleared: result.modifiedCount };
  }

  // ============== Admin moderation ==============

  async adminRemove(roomId: string, reason: string, adminId?: string) {
    const room = await this.getOrThrow(roomId, { includeRemoved: true });
    room.status = RoomStatus.REMOVED;
    room.removedReason = reason;
    if (adminId && Types.ObjectId.isValid(adminId)) {
      room.removedBy = new Types.ObjectId(adminId);
    }
    await room.save();
    // Clear presence + seats so anyone currently inside drops cleanly.
    await Promise.all([
      this.memberModel.deleteMany({ roomId: room._id }).exec(),
      this.seatModel
        .updateMany(
          { roomId: room._id, userId: { $ne: null } },
          { $set: { userId: null, joinedAt: null, muted: false, mutedBy: null, videoEnabled: false } },
        )
        .exec(),
      this.roomModel
        .updateOne({ _id: room._id }, { $set: { viewerCount: 0, liveAt: null } })
        .exec(),
    ]);
    return room;
  }

  /**
   * Reverse `adminRemove` — flip REMOVED back to ACTIVE so an
   * accidentally-removed room can be brought back without the owner
   * having to re-create it. Clears the removal trace fields too,
   * because keeping a `removedBy/Reason` on an ACTIVE room is
   * misleading. Idempotent on already-ACTIVE rooms.
   */
  async adminRestore(roomId: string) {
    const room = await this.getOrThrow(roomId, { includeRemoved: true });
    if (room.status === RoomStatus.ACTIVE) return room;
    room.status = RoomStatus.ACTIVE;
    room.removedReason = '';
    room.removedBy = null;
    await room.save();
    return room;
  }

  /**
   * Admin list — separate from `listLive` because admins need to see
   * CLOSED / REMOVED rooms too, search by name + numericId, and
   * filter by ownerCountry. Sorted by `createdAt` desc so the newest
   * rooms surface first; admins can flip to `liveAt` for "what's
   * popping right now" once we wire a sort param.
   */
  async adminList(params: {
    page?: number;
    limit?: number;
    status?: RoomStatus;
    country?: string;
    search?: string;
  }) {
    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(100, Math.max(1, params.limit ?? 20));
    const skip = (page - 1) * limit;

    const filter: FilterQuery<RoomDocument> = {};
    if (params.status) filter.status = params.status;
    if (params.country && params.country.length === 2) {
      filter.ownerCountry = params.country.toUpperCase();
    }
    if (params.search && params.search.trim().length > 0) {
      const q = params.search.trim();
      // Numeric search → match exact public id; otherwise treat as a
      // name fragment (case-insensitive). Anchor-free regex keeps the
      // common "starts with" UX without making admins type a wildcard.
      const asNumber = Number(q);
      if (!Number.isNaN(asNumber) && Number.isFinite(asNumber)) {
        filter.$or = [
          { numericId: asNumber },
          { name: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
        ];
      } else {
        filter.name = {
          $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
          $options: 'i',
        };
      }
    }

    const [items, total] = await Promise.all([
      this.roomModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('ownerId', 'username displayName avatarUrl numericId country')
        .exec(),
      this.roomModel.countDocuments(filter).exec(),
    ]);

    return {
      items: items.map((r) => r.toJSON()),
      page,
      limit,
      total,
    };
  }
}
