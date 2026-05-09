import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';

import { MediaService } from '../media/media.service';
import { RedisService } from '../../redis/redis.service';
import {
  CosmeticAssetType,
  CosmeticItem,
  CosmeticItemDocument,
  CosmeticType,
} from './schemas/cosmetic-item.schema';
import {
  CosmeticSource,
  UserCosmetic,
  UserCosmeticDocument,
} from './schemas/user-cosmetic.schema';

/// Per-user equipped-cosmetics cache. Reads happen on every room
/// snapshot fetch + every `room.member.joined` (vehicle lookup), and
/// the underlying query joins UserCosmetic ⨝ CosmeticItem with a
/// `populate`. Caching by userId in Redis cuts that to a single
/// Redis GET per user once warm; the TTL plus explicit invalidation
/// on `equip()` / `grantToUser()` keeps stale data within bounds.
const EQUIPPED_CACHE_TTL_SECONDS = 30;
const EQUIPPED_CACHE_KEY = (userId: string) => `cosmetics:equipped:${userId}`;

interface ListItemsParams {
  page?: number;
  limit?: number;
  type?: CosmeticType;
  active?: boolean;
  search?: string;
}

@Injectable()
export class CosmeticsService {
  constructor(
    @InjectModel(CosmeticItem.name)
    private readonly itemModel: Model<CosmeticItemDocument>,
    @InjectModel(UserCosmetic.name)
    private readonly userCosmeticModel: Model<UserCosmeticDocument>,
    private readonly media: MediaService,
    private readonly redis: RedisService,
  ) {}

  // ============== Catalog (admin-side CRUD) ==============

  async list(params: ListItemsParams) {
    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(100, Math.max(1, params.limit ?? 50));
    const skip = (page - 1) * limit;

    const filter: FilterQuery<CosmeticItemDocument> = {};
    if (params.type) filter.type = params.type;
    if (params.active !== undefined) filter.active = params.active;
    if (params.search) {
      const escaped = params.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      filter.$or = [
        { code: regex },
        { 'name.en': regex },
        { 'name.bn': regex },
      ];
    }

    const [items, total] = await Promise.all([
      this.itemModel
        .find(filter)
        .sort({ type: 1, sortOrder: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      this.itemModel.countDocuments(filter).exec(),
    ]);
    return { items, page, limit, total };
  }

  async findById(id: string): Promise<CosmeticItemDocument | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return this.itemModel.findById(id).exec();
  }

  /**
   * Bulk-fetch active cosmetic items by id. Filters out invalid ids
   * client-side so a single bad id in a batch doesn't reject the
   * whole request. Used by the mobile SVIP page to render thumbnails
   * for tier-granted items that aren't sold via the store (and so
   * don't surface in `/store/listings`).
   *
   * Cap at 100 ids per call — way more than any legitimate caller
   * needs, and keeps the index scan bounded.
   */
  async findActiveByIds(ids: string[]): Promise<CosmeticItemDocument[]> {
    const valid = ids
      .filter((id) => typeof id === 'string' && Types.ObjectId.isValid(id))
      .slice(0, 100)
      .map((id) => new Types.ObjectId(id));
    if (valid.length === 0) return [];
    return this.itemModel
      .find({ _id: { $in: valid }, active: true })
      .exec();
  }

  async getByIdOrThrow(id: string): Promise<CosmeticItemDocument> {
    const it = await this.findById(id);
    if (!it) throw new NotFoundException('Cosmetic item not found');
    return it;
  }

  async create(input: any, createdBy?: string): Promise<CosmeticItemDocument> {
    const codeUpper = input.code.toUpperCase();
    const exists = await this.itemModel.countDocuments({ code: codeUpper }).exec();
    if (exists) {
      throw new ConflictException({
        code: 'COSMETIC_CODE_TAKEN',
        message: `Cosmetic code "${codeUpper}" already in use`,
      });
    }
    return this.itemModel.create({
      ...input,
      code: codeUpper,
      createdBy:
        createdBy && Types.ObjectId.isValid(createdBy)
          ? new Types.ObjectId(createdBy)
          : null,
    });
  }

  async update(id: string, update: any): Promise<CosmeticItemDocument> {
    const it = await this.getByIdOrThrow(id);

    if (update.code !== undefined) {
      const codeUpper = update.code.toUpperCase();
      if (codeUpper !== it.code) {
        const exists = await this.itemModel.countDocuments({ code: codeUpper }).exec();
        if (exists) {
          throw new ConflictException({ code: 'COSMETIC_CODE_TAKEN', message: 'Code in use' });
        }
        it.code = codeUpper;
      }
    }
    if (update.name !== undefined) it.name = update.name;
    if (update.description !== undefined) it.description = update.description;
    if (update.type !== undefined) it.type = update.type;
    if (update.previewUrl !== undefined) it.previewUrl = update.previewUrl;
    if (update.previewPublicId !== undefined) it.previewPublicId = update.previewPublicId;
    if (update.assetUrl !== undefined) it.assetUrl = update.assetUrl;
    if (update.assetPublicId !== undefined) it.assetPublicId = update.assetPublicId;
    if (update.assetType !== undefined) it.assetType = update.assetType;
    if (update.rarity !== undefined) it.rarity = update.rarity;
    if (update.active !== undefined) it.active = update.active;
    if (update.sortOrder !== undefined) it.sortOrder = update.sortOrder;

    await it.save();
    return it;
  }

  async softDelete(id: string): Promise<void> {
    const it = await this.getByIdOrThrow(id);
    it.active = false;
    await it.save();
  }

  // ============== Media upload helpers ==============

  /**
   * Upload preview (image) for a cosmetic. Returns { url, publicId } so the
   * controller can persist them on the item record.
   */
  async uploadPreview(buffer: Buffer): Promise<{ url: string; publicId: string }> {
    const res = await this.media.uploadImage(buffer, { folder: 'cosmetics/previews' });
    return { url: res.secure_url, publicId: res.public_id };
  }

  /**
   * Upload animated asset (SVGA/Lottie) as a "raw" Cloudinary resource.
   * MP4 would use `video` instead — caller passes the resourceType via
   * inferring from the file extension/mimetype.
   */
  async uploadAsset(
    buffer: Buffer,
    resourceType: 'raw' | 'video',
  ): Promise<{ url: string; publicId: string }> {
    const res = await this.media.uploadAsset(buffer, {
      folder: 'cosmetics/assets',
      resourceType,
    });
    return { url: res.secure_url, publicId: res.public_id };
  }

  // ============== User inventory (used by SVIP / Store / Gift) ==============

  /**
   * Idempotent grant. If a user already owns this item from this source +
   * externalRef, return the existing record (and extend expiry if longer).
   */
  async grantToUser(params: {
    userId: string;
    cosmeticItemId: string;
    source: CosmeticSource;
    durationDays?: number | null;
    giftedBy?: string;
    svipTier?: number;
    externalRef?: string;
  }): Promise<UserCosmeticDocument> {
    const userObj = new Types.ObjectId(params.userId);
    const itemObj = new Types.ObjectId(params.cosmeticItemId);
    const externalRef = params.externalRef ?? '';

    const expiresAt =
      params.durationDays && params.durationDays > 0
        ? new Date(Date.now() + params.durationDays * 86_400_000)
        : null;

    const existing = await this.userCosmeticModel
      .findOne({
        userId: userObj,
        cosmeticItemId: itemObj,
        source: params.source,
        externalRef,
      })
      .exec();

    if (existing) {
      // Extend expiry if the new grant is longer.
      if (expiresAt && (!existing.expiresAt || existing.expiresAt < expiresAt)) {
        existing.expiresAt = expiresAt;
        await existing.save();
      } else if (expiresAt === null && existing.expiresAt) {
        existing.expiresAt = null;
        await existing.save();
      }
      // Expiry change can flip a previously-expired item back to
      // valid for the equipped query, so bust the cache either way.
      await this._bustEquippedCache(params.userId);
      return existing;
    }

    const created = await this.userCosmeticModel.create({
      userId: userObj,
      cosmeticItemId: itemObj,
      source: params.source,
      externalRef,
      acquiredAt: new Date(),
      expiresAt,
      giftedBy:
        params.giftedBy && Types.ObjectId.isValid(params.giftedBy)
          ? new Types.ObjectId(params.giftedBy)
          : null,
      svipTier: params.svipTier ?? null,
    });
    // New rows are created with `equipped: false` by the schema default,
    // so this doesn't change the equipped set immediately. Still bust
    // the cache to keep the stored entry honest in case the caller
    // proceeds to equip the new item right away.
    await this._bustEquippedCache(params.userId);
    return created;
  }

  /** All cosmetics owned by a user, including expired (caller can filter). */
  async listUserCosmetics(userId: string) {
    if (!Types.ObjectId.isValid(userId)) return [];
    return this.userCosmeticModel
      .find({ userId: new Types.ObjectId(userId) })
      .sort({ acquiredAt: -1 })
      .populate('cosmeticItemId')
      .exec();
  }

  /**
   * Equipped cosmetics for a batch of users. Returns plain JSON objects
   * (the toJSON form of UserCosmetic with `cosmeticItemId` populated as
   * an inline CosmeticItem JSON) — same shape that hits the wire when
   * the controller forwards the result. Plain JSON makes the Redis
   * cache trivially round-trippable.
   *
   * Cache strategy: per-user 30s TTL keyed by userId. Cache is busted
   * explicitly in `equip()` and `grantToUser()` so the user sees their
   * own changes immediately on the next read.
   *
   * Skips expired rows. Only `equipped: true` is returned.
   */
  async listEquippedForUsers(
    userIds: string[],
  ): Promise<Array<Record<string, unknown>>> {
    const valid = userIds.filter((id) => Types.ObjectId.isValid(id));
    if (valid.length === 0) return [];

    // Try the Redis cache for every userId in parallel. Hits are
    // arrays of equipped JSON; misses are the userIds we still need to
    // hit Mongo for.
    const cacheKeys = valid.map(EQUIPPED_CACHE_KEY);
    const cached = await Promise.all(cacheKeys.map((k) => this.redis.get(k)));

    const out: Array<Record<string, unknown>> = [];
    const misses: string[] = [];
    cached.forEach((c, i) => {
      if (c == null) {
        misses.push(valid[i]);
        return;
      }
      try {
        const parsed = JSON.parse(c) as Array<Record<string, unknown>>;
        if (Array.isArray(parsed)) out.push(...parsed);
      } catch {
        // Corrupt entry — treat as miss; the fresh fetch will overwrite it.
        misses.push(valid[i]);
      }
    });

    if (misses.length === 0) return out;

    // One DB round-trip for everyone we couldn't cache-hit.
    const now = new Date();
    const fresh = await this.userCosmeticModel
      .find({
        userId: { $in: misses.map((id) => new Types.ObjectId(id)) },
        equipped: true,
        $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
      })
      .populate('cosmeticItemId')
      .exec();

    // Group by userId so we can write one cache entry per user — even
    // for users with no equipped items (cache the empty list, otherwise
    // every join for a fresh account would re-query the DB).
    const byUser = new Map<string, Array<Record<string, unknown>>>();
    for (const id of misses) byUser.set(id, []);
    for (const row of fresh) {
      const id = row.userId.toString();
      const json = row.toJSON() as Record<string, unknown>;
      byUser.get(id)?.push(json);
      out.push(json);
    }

    // Fire-and-forget cache writes — failures here are fine; next read
    // will just hit Mongo again.
    for (const [id, items] of byUser) {
      this.redis
        .set(EQUIPPED_CACHE_KEY(id), JSON.stringify(items), EQUIPPED_CACHE_TTL_SECONDS)
        .catch(() => undefined);
    }

    return out;
  }

  /// Drop the cached equipped list for a single user. Called from any
  /// path that mutates equipped state (equip / grant / etc.) so the
  /// next read pulls fresh from Mongo.
  private async _bustEquippedCache(userId: string): Promise<void> {
    if (!Types.ObjectId.isValid(userId)) return;
    await this.redis.del(EQUIPPED_CACHE_KEY(userId)).catch(() => undefined);
  }

  /**
   * Mark one item as equipped for a user, unequipping any other of the same
   * `type` so the user has at most one active item per slot.
   */
  async equip(userId: string, userCosmeticId: string): Promise<UserCosmeticDocument> {
    const owned = await this.userCosmeticModel.findById(userCosmeticId).exec();
    if (!owned || owned.userId.toString() !== userId) {
      throw new NotFoundException('Cosmetic not owned');
    }
    if (owned.expiresAt && owned.expiresAt < new Date()) {
      throw new ConflictException({
        code: 'COSMETIC_EXPIRED',
        message: 'This cosmetic has expired',
      });
    }
    const item = await this.itemModel.findById(owned.cosmeticItemId).exec();
    if (!item) throw new NotFoundException('Cosmetic item missing');

    // Unequip any other of the same type for this user.
    const peerItemIds = await this.itemModel.find({ type: item.type }, { _id: 1 }).exec();
    await this.userCosmeticModel
      .updateMany(
        {
          userId: new Types.ObjectId(userId),
          cosmeticItemId: { $in: peerItemIds.map((p) => p._id) },
          equipped: true,
        },
        { $set: { equipped: false } },
      )
      .exec();

    owned.equipped = true;
    await owned.save();
    // The user's equipped set just changed (one item flipped on, peers
    // of the same type flipped off). Drop their cache so the next read
    // — usually the same client refreshing inventory + the room view —
    // pulls the fresh state instead of the up-to-30s-stale entry.
    await this._bustEquippedCache(userId);
    return owned;
  }

  /**
   * Flip one user-cosmetic to `equipped: false`. Used by the My Items
   * unequip button so the user can intentionally take off a frame /
   * theme without having to equip a different one. Idempotent — a
   * not-equipped row just touches no fields.
   */
  async unequip(userId: string, userCosmeticId: string): Promise<UserCosmeticDocument> {
    const owned = await this.userCosmeticModel.findById(userCosmeticId).exec();
    if (!owned || owned.userId.toString() !== userId) {
      throw new NotFoundException('Cosmetic not owned');
    }
    if (owned.equipped) {
      owned.equipped = false;
      await owned.save();
      await this._bustEquippedCache(userId);
    }
    return owned;
  }

  /**
   * Equip every SVIP-granted cosmetic the user owns whose source tier
   * is ≤ `level` (lower SVIP tiers stack — buying SVIP3 keeps SVIP1's
   * benefits visible). For each cosmetic type seen across the granted
   * set, the highest-tier item wins, and any other equipped item of
   * the same type (store / gift / etc.) is automatically unequipped to
   * preserve the "one per type" invariant.
   *
   * Returns the count of items flipped to equipped — useful for
   * snackbars ("Equipped 5 SVIP cosmetics").
   */
  async equipSvipTier(userId: string, level: number): Promise<number> {
    if (!Types.ObjectId.isValid(userId) || level <= 0) return 0;
    const userOid = new Types.ObjectId(userId);
    const now = new Date();

    // Pull every SVIP-source cosmetic the user owns up to + including
    // this tier, with the underlying item populated so we can pick by
    // type. Excludes expired entries.
    const owned = await this.userCosmeticModel
      .find({
        userId: userOid,
        source: CosmeticSource.SVIP,
        svipTier: { $ne: null, $lte: level },
        $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
      })
      .populate('cosmeticItemId')
      .exec();
    if (owned.length === 0) return 0;

    // Pick the winning item per type — highest svipTier wins. Ties
    // broken by acquiredAt-desc so a re-grant at the same tier still
    // resolves deterministically.
    const winnerByType = new Map<string, UserCosmeticDocument>();
    for (const row of owned) {
      const item = row.cosmeticItemId as unknown as { type?: string } | null;
      const type = item?.type;
      if (!type) continue;
      const incumbent = winnerByType.get(type);
      if (!incumbent) {
        winnerByType.set(type, row);
        continue;
      }
      const a = row.svipTier ?? 0;
      const b = incumbent.svipTier ?? 0;
      if (a > b || (a === b && row.acquiredAt > incumbent.acquiredAt)) {
        winnerByType.set(type, row);
      }
    }
    if (winnerByType.size === 0) return 0;

    const winnerIds = Array.from(winnerByType.values()).map((r) => r._id);
    const types = Array.from(winnerByType.keys());

    // Unequip every existing equipped row of these types — one
    // sweeping `updateMany` covers both the SVIP losers (lower-tier
    // items in the same type) and any non-SVIP items the user had
    // equipped (store frame, gift theme, etc.).
    const peerItemIds = await this.itemModel
      .find({ type: { $in: types } }, { _id: 1 })
      .exec();
    await this.userCosmeticModel
      .updateMany(
        {
          userId: userOid,
          cosmeticItemId: { $in: peerItemIds.map((p) => p._id) },
          equipped: true,
        },
        { $set: { equipped: false } },
      )
      .exec();

    // Equip the winners.
    await this.userCosmeticModel
      .updateMany(
        { _id: { $in: winnerIds } },
        { $set: { equipped: true } },
      )
      .exec();

    await this._bustEquippedCache(userId);
    return winnerIds.length;
  }

  /**
   * Unequip every cosmetic owned via `source` for this user. Used by
   * SVIP `deactivate` to take the badge off — every SVIP-source
   * cosmetic comes off too, so the user is back to whatever they had
   * before activating (they can re-equip store items manually).
   */
  async unequipBySource(
    userId: string,
    source: CosmeticSource,
  ): Promise<number> {
    if (!Types.ObjectId.isValid(userId)) return 0;
    const res = await this.userCosmeticModel
      .updateMany(
        {
          userId: new Types.ObjectId(userId),
          source,
          equipped: true,
        },
        { $set: { equipped: false } },
      )
      .exec();
    if ((res.modifiedCount ?? 0) > 0) {
      await this._bustEquippedCache(userId);
    }
    return res.modifiedCount ?? 0;
  }
}
