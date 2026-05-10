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
import { User, UserDocument } from '../users/schemas/user.schema';
import { CreateRoomDto, UpdateRoomSettingsDto } from './dto/room.dto';
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
  RoomSeat,
  RoomSeatDocument,
} from './schemas/room-seat.schema';
import {
  Room,
  RoomDocument,
  RoomKind,
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
   * First-time room creation. One audio room per user — calling twice
   * returns the existing room rather than 409, so the client can call
   * this on every "open Mine tab" without thinking.
   */
  async createOrGetOwn(
    ownerId: string,
    input: CreateRoomDto,
  ): Promise<RoomDocument> {
    if (!Types.ObjectId.isValid(ownerId)) {
      throw new BadRequestException({ code: 'INVALID_USER_ID', message: 'Invalid user' });
    }
    const kind = input.kind ?? RoomKind.AUDIO;
    const ownerOid = new Types.ObjectId(ownerId);

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
      // Restore from CLOSED if owner is creating again. Avoids leaving the
      // owner without a room after a self-close.
      if (existing.status === RoomStatus.CLOSED) {
        existing.status = RoomStatus.ACTIVE;
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
    const micCount = input.micCount ?? 8;
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
        numericId,
        name,
        announcement: input.announcement?.trim() ?? '',
        coverUrl,
        micCount,
        status: RoomStatus.ACTIVE,
      }),
    );

    // Seed seats: index 0 = owner, 1..micCount = guest seats.
    const seatDocs = [
      { roomId: room._id, seatIndex: 0, locked: false, muted: false, userId: null },
    ];
    for (let i = 1; i <= micCount; i++) {
      seatDocs.push({
        roomId: room._id,
        seatIndex: i,
        locked: false,
        muted: false,
        userId: null,
      });
    }
    await this.seatModel.insertMany(seatDocs);

    return room;
  }

  /** GET /rooms/me — the caller's own room (audio for now). */
  async getOwnRoom(ownerId: string, kind: RoomKind = RoomKind.AUDIO) {
    if (!Types.ObjectId.isValid(ownerId)) return null;
    const room = await this.roomModel
      .findOne({ ownerId: new Types.ObjectId(ownerId), kind })
      .exec();
    if (!room || room.status === RoomStatus.REMOVED) return null;
    return room;
  }

  /** Public read by id or numericId (the latter is what users type). */
  async getOrThrow(idOrNumeric: string): Promise<RoomDocument> {
    let room: RoomDocument | null = null;
    if (Types.ObjectId.isValid(idOrNumeric)) {
      room = await this.roomModel.findById(idOrNumeric).exec();
    } else if (/^\d+$/.test(idOrNumeric)) {
      room = await this.roomModel
        .findOne({ numericId: parseInt(idOrNumeric, 10) })
        .exec();
    }
    if (!room || room.status === RoomStatus.REMOVED) {
      throw new NotFoundException({
        code: 'ROOM_NOT_FOUND',
        message: 'Room not found',
      });
    }
    return room;
  }

  /** Returns the room hydrated with author + seats + members for the
   *  in-room screen. One round-trip; mobile client can paint from this. */
  async getSnapshot(roomId: string) {
    const room = await this.getOrThrow(roomId);
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

    const removed = await this.memberModel
      .deleteOne({ roomId: room._id, userId: userOid })
      .exec();
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
          { $set: { userId: null, joinedAt: null, muted: false } },
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

    return { ok: true };
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
          $set: { userId: userOid, joinedAt: new Date(), muted: false },
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
          { $set: { userId: null, joinedAt: null, muted: false } },
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
        { $set: { userId: null, joinedAt: null, muted: false } },
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

  /** Owner/admin: force-mute a seat. The user keeps the seat but stops
   *  publishing audio (the realtime layer signals their client). */
  async setSeatMuted(
    roomId: string,
    actorId: string,
    seatIndex: number,
    muted: boolean,
  ) {
    const room = await this.assertOwnerOrAdmin(roomId, actorId);
    const seat = await this.seatModel
      .findOneAndUpdate(
        { roomId: room._id, seatIndex },
        { $set: { muted } },
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
        { $set: { userId: null, joinedAt: null, muted: false } },
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
          { $set: { userId: null, joinedAt: null, muted: false } },
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
    const room = await this.getOrThrow(roomId);
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
          { $set: { userId: null, joinedAt: null, muted: false } },
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
    const room = await this.getOrThrow(roomId);
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
