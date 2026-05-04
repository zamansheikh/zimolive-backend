import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import {
  RoomSeat,
  RoomSeatDocument,
} from '../rooms/schemas/room-seat.schema';
import { RealtimeEventType } from '../realtime/realtime.types';
import { RealtimeService } from '../realtime/realtime.service';
import { CreateRoomEmojiDto, UpdateRoomEmojiDto } from './dto/room-emoji.dto';
import {
  RoomEmoji,
  RoomEmojiDocument,
  RoomEmojiType,
} from './schemas/room-emoji.schema';

/**
 * Room emoji reactions service.
 *
 *   • Catalog CRUD for the admin panel (the emojis themselves).
 *   • Public list for the mobile picker.
 *   • Send-react: only seated users may fire; broadcasts to the room.
 *
 * Storage: emojis are a small global catalog (tens of rows). No per-room
 * scoping for now — the picker shows the same set in every room. Adding
 * per-tier or per-room visibility later is just a filter on the public
 * list.
 */
@Injectable()
export class RoomEmojisService {
  constructor(
    @InjectModel(RoomEmoji.name)
    private readonly emojiModel: Model<RoomEmojiDocument>,
    @InjectModel(RoomSeat.name)
    private readonly seatModel: Model<RoomSeatDocument>,
    private readonly realtime: RealtimeService,
  ) {}

  // ---------- Catalog (admin) ----------

  async listAll() {
    return this.emojiModel
      .find({})
      .sort({ active: -1, sortOrder: 1, createdAt: 1 })
      .exec();
  }

  async listActive() {
    return this.emojiModel
      .find({ active: true })
      .sort({ sortOrder: 1, createdAt: 1 })
      .exec();
  }

  async create(input: CreateRoomEmojiDto) {
    this.assertAssetForType(input);
    return this.emojiModel.create({
      name: input.name,
      category: input.category ?? 'general',
      type: input.type,
      assetUrl: input.assetUrl ?? '',
      assetPublicId: input.assetPublicId ?? '',
      char: input.char ?? '',
      durationMs: input.durationMs ?? 3000,
      active: input.active ?? true,
      sortOrder: input.sortOrder ?? 0,
    });
  }

  async update(id: string, input: UpdateRoomEmojiDto) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Emoji not found');
    }
    const e = await this.emojiModel.findById(id).exec();
    if (!e) throw new NotFoundException('Emoji not found');

    // If the type changes or the asset changes, re-validate the
    // (type, asset) pair so we never end up with e.g. a `char` row
    // that has no character.
    const next = {
      type: input.type ?? e.type,
      assetUrl: input.assetUrl ?? e.assetUrl,
      char: input.char ?? e.char,
    };
    this.assertAssetForType(next);

    if (input.name !== undefined) e.name = input.name;
    if (input.category !== undefined) e.category = input.category;
    if (input.type !== undefined) e.type = input.type;
    if (input.assetUrl !== undefined) e.assetUrl = input.assetUrl;
    if (input.assetPublicId !== undefined) e.assetPublicId = input.assetPublicId;
    if (input.char !== undefined) e.char = input.char;
    if (input.durationMs !== undefined) e.durationMs = input.durationMs;
    if (input.active !== undefined) e.active = input.active;
    if (input.sortOrder !== undefined) e.sortOrder = input.sortOrder;
    await e.save();
    return e;
  }

  /** Soft delete — keeps history but hides from picker. */
  async softDelete(id: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Emoji not found');
    }
    const e = await this.emojiModel.findById(id).exec();
    if (!e) throw new NotFoundException('Emoji not found');
    e.active = false;
    await e.save();
  }

  // ---------- Send (public, seated-only) ----------

  /**
   * Fire `emojiId` over the caller's seat. Server validates the user
   * is seated (and optionally on a specific seat — we just look up
   * any seat owned by the caller in this room) and broadcasts a
   * realtime event so every member animates the reaction at the same
   * time.
   *
   * Returns the seatIndex it landed on so the caller can paint the
   * overlay locally without waiting for the round-trip via the
   * realtime stream.
   */
  async sendToSeat(roomId: string, userId: string, emojiId: string) {
    if (!Types.ObjectId.isValid(roomId)) {
      throw new BadRequestException({
        code: 'INVALID_ROOM_ID',
        message: 'Invalid room id',
      });
    }
    if (!Types.ObjectId.isValid(userId)) {
      throw new BadRequestException({
        code: 'INVALID_USER_ID',
        message: 'Invalid user id',
      });
    }
    if (!Types.ObjectId.isValid(emojiId)) {
      throw new NotFoundException({
        code: 'EMOJI_NOT_FOUND',
        message: 'Emoji not found',
      });
    }
    const emoji = await this.emojiModel.findById(emojiId).exec();
    if (!emoji || !emoji.active) {
      throw new NotFoundException({
        code: 'EMOJI_NOT_FOUND',
        message: 'Emoji not found',
      });
    }

    // Find the caller's seat in this room. Owners hold seat 0; guests
    // 1..micCount. We pick the lowest seat index they hold (one user
    // can only ever be on one seat, so this is just a defensive
    // ordering).
    const seat = await this.seatModel
      .findOne({
        roomId: new Types.ObjectId(roomId),
        userId: new Types.ObjectId(userId),
      })
      .sort({ seatIndex: 1 })
      .exec();
    if (!seat) {
      throw new ForbiddenException({
        code: 'NOT_SEATED',
        message: 'Take a seat to send a reaction',
      });
    }

    const payload = {
      seatIndex: seat.seatIndex,
      userId,
      emoji: {
        id: emoji._id.toString(),
        name: emoji.name,
        type: emoji.type,
        assetUrl: emoji.type === RoomEmojiType.CHAR ? '' : emoji.assetUrl,
        char: emoji.type === RoomEmojiType.CHAR ? emoji.char : '',
      },
      durationMs: emoji.durationMs,
    };
    void this.realtime.emitToRoom(
      roomId,
      RealtimeEventType.ROOM_SEAT_EMOJI,
      payload,
    );
    return payload;
  }

  // ---------- Helpers ----------

  /**
   * Reject creates / updates that don't supply the asset matching the
   * declared type. Without this, a `char` emoji with no character or
   * an `image` emoji with no URL would render as a blank tile in the
   * picker.
   */
  private assertAssetForType(input: {
    type: RoomEmojiType;
    assetUrl?: string;
    char?: string;
  }) {
    if (input.type === RoomEmojiType.CHAR) {
      if (!input.char || input.char.trim().length === 0) {
        throw new BadRequestException({
          code: 'CHAR_REQUIRED',
          message: 'A character is required for char-type emojis',
        });
      }
    } else if (
      input.type === RoomEmojiType.IMAGE ||
      input.type === RoomEmojiType.SVGA
    ) {
      if (!input.assetUrl || input.assetUrl.trim().length === 0) {
        throw new BadRequestException({
          code: 'ASSET_REQUIRED',
          message: 'An asset URL is required for image / svga emojis',
        });
      }
    }
  }
}
