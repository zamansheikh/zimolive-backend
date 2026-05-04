import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model } from 'mongoose';

import { Room, RoomDocument, RoomStatus } from '../rooms/schemas/room.schema';
import { User, UserDocument, UserStatus } from '../users/schemas/user.schema';

/**
 * Combined search across rooms + users for the home-screen search bar.
 * Backend keeps it simple: one query, two collections, two result sets.
 *
 *   • Numeric query → exact match on `numericId` on both collections.
 *   • Text query → case-insensitive regex on Room.name + User.displayName
 *     + User.username. Anchored to the START of the field so "AKA" doesn't
 *     match "Lakshmi" but does match "Akash" — keeps results predictable.
 *
 * Results are capped per type (default 20 each) so payloads stay tight on
 * mobile and the search bar feels instant.
 */
@Injectable()
export class SearchService {
  constructor(
    @InjectModel(Room.name) private readonly roomModel: Model<RoomDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
  ) {}

  async search(rawQuery: string, limit = 20) {
    const q = rawQuery.trim();
    if (q.length === 0) {
      return { query: q, rooms: [], users: [] };
    }
    if (q.length > 40) {
      throw new BadRequestException({
        code: 'QUERY_TOO_LONG',
        message: 'Search query must be 40 characters or fewer.',
      });
    }
    const cap = Math.min(50, Math.max(1, limit));
    const isNumeric = /^\d+$/.test(q);
    const numericValue = isNumeric ? parseInt(q, 10) : null;

    // Build the room filter. Numeric queries hit `numericId` first
    // (cheap exact lookup), but we ALSO regex against the name so "1234"
    // typed into a name like "Room1234" still matches.
    const escapedQ = this._escapeRegex(q);
    const roomNameRegex = new RegExp(`^${escapedQ}`, 'i');
    const roomFilter: FilterQuery<RoomDocument> = {
      status: RoomStatus.ACTIVE,
      $or: [
        { name: roomNameRegex },
        ...(numericValue != null ? [{ numericId: numericValue }] : []),
      ],
    };

    // Users: never expose deleted / banned via search.
    const userTextRegex = new RegExp(`^${escapedQ}`, 'i');
    const userFilter: FilterQuery<UserDocument> = {
      status: { $ne: UserStatus.DELETED },
      $or: [
        { displayName: userTextRegex },
        { username: userTextRegex },
        ...(numericValue != null ? [{ numericId: numericValue }] : []),
      ],
    };

    const [rooms, users] = await Promise.all([
      this.roomModel
        .find(roomFilter)
        // Live rooms first (viewerCount > 0), then by recency. Cheap
        // sort because both fields are indexed.
        .sort({ viewerCount: -1, liveAt: -1 })
        .limit(cap)
        .select({
          _id: 1,
          numericId: 1,
          name: 1,
          coverUrl: 1,
          ownerId: 1,
          viewerCount: 1,
          liveAt: 1,
        })
        .populate('ownerId', 'username displayName avatarUrl numericId')
        .lean()
        .exec(),
      this.userModel
        .find(userFilter)
        .limit(cap)
        .select({
          _id: 1,
          numericId: 1,
          username: 1,
          displayName: 1,
          avatarUrl: 1,
          isHost: 1,
          level: 1,
        })
        .lean()
        .exec(),
    ]);

    return {
      query: q,
      rooms: rooms.map((r) => {
        const owner = r.ownerId as unknown as
          | {
              _id: { toString(): string };
              username?: string;
              displayName?: string;
              avatarUrl?: string;
              numericId?: number | null;
            }
          | null
          | undefined;
        return {
          id: r._id.toString(),
          numericId: r.numericId ?? null,
          name: r.name ?? '',
          coverUrl: r.coverUrl ?? '',
          viewerCount: r.viewerCount ?? 0,
          liveAt: r.liveAt ?? null,
          owner: owner
            ? {
                id: owner._id.toString(),
                displayName: owner.displayName ?? '',
                username: owner.username ?? '',
                avatarUrl: owner.avatarUrl ?? '',
                numericId: owner.numericId ?? null,
              }
            : null,
        };
      }),
      users: users.map((u) => ({
        id: u._id.toString(),
        numericId: u.numericId ?? null,
        username: u.username ?? '',
        displayName: u.displayName ?? '',
        avatarUrl: u.avatarUrl ?? '',
        isHost: u.isHost ?? false,
        level: u.level ?? 1,
      })),
    };
  }

  /** Escape user input before injecting it into a RegExp — protects
   *  against ReDoS + accidental special-character matching. */
  private _escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
