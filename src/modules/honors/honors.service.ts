import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';

import {
  CreateHonorItemDto,
  GrantHonorDto,
  UpdateHonorItemDto,
} from './dto/honors.dto';
import { MediaService } from '../media/media.service';
import {
  HonorAssetType,
  HonorCategory,
  HonorItem,
  HonorItemDocument,
  HonorMetric,
} from './schemas/honor-item.schema';
import { HonorMetricsService } from './metrics.service';
import {
  HonorSource,
  UserHonor,
  UserHonorDocument,
} from './schemas/user-honor.schema';

interface ListCatalogParams {
  category?: HonorCategory;
  search?: string;
  active?: boolean;
  page?: number;
  limit?: number;
}

/**
 * Honor / achievement system.
 *
 * The catalog is admin-managed; user inventory grows via either:
 *   • direct admin grant (this service's `grantToUser`),
 *   • the task system calling `awardByKey(userId, key, tier?)` from
 *     other modules (room thresholds, recharge milestones, etc.) —
 *     same code path as admin grants but with `source: TASK`.
 *
 * Tiers live on the user's row, not the catalog row, so re-granting
 * the same item to a user just bumps their tier and `awardedAt` via
 * the unique (userId, honorItemId) index — no duplicate inventory.
 */
@Injectable()
export class HonorsService {
  constructor(
    @InjectModel(HonorItem.name)
    private readonly itemModel: Model<HonorItemDocument>,
    @InjectModel(UserHonor.name)
    private readonly userHonorModel: Model<UserHonorDocument>,
    private readonly media: MediaService,
    private readonly metrics: HonorMetricsService,
  ) {}

  // ============== Asset uploads ==============

  /// Upload a static image icon. Returns Cloudinary URL + publicId.
  /// Mirrors `cosmetics.service.ts` so admins use the same picker UX.
  async uploadIconImage(
    buffer: Buffer,
  ): Promise<{ url: string; publicId: string; assetType: HonorAssetType }> {
    const res = await this.media.uploadImage(buffer, {
      folder: 'honors/icons',
    });
    return {
      url: res.secure_url,
      publicId: res.public_id,
      assetType: HonorAssetType.IMAGE,
    };
  }

  /// Upload an SVGA animated icon. Cloudinary stores SVGA as
  /// `resource_type: raw` (binary blob with no transcoding).
  async uploadIconSvga(
    buffer: Buffer,
  ): Promise<{ url: string; publicId: string; assetType: HonorAssetType }> {
    const res = await this.media.uploadAsset(buffer, {
      folder: 'honors/svga',
      resourceType: 'raw',
    });
    return {
      url: res.secure_url,
      publicId: res.public_id,
      assetType: HonorAssetType.SVGA,
    };
  }

  // ============== Catalog ==============

  async listCatalog(params: ListCatalogParams = {}) {
    const filter: FilterQuery<HonorItemDocument> = {};
    if (params.category) filter.category = params.category;
    if (params.active !== undefined) filter.active = params.active;
    if (params.search && params.search.trim().length > 0) {
      const q = params.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { name: { $regex: q, $options: 'i' } },
        { key: { $regex: q, $options: 'i' } },
      ];
    }
    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(200, Math.max(1, params.limit ?? 50));
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      this.itemModel
        .find(filter)
        .sort({ sortOrder: 1, name: 1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      this.itemModel.countDocuments(filter).exec(),
    ]);
    return { items: items.map((i) => i.toJSON()), page, limit, total };
  }

  async getById(id: string): Promise<HonorItemDocument | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return this.itemModel.findById(id).exec();
  }

  async getByIdOrThrow(id: string): Promise<HonorItemDocument> {
    const item = await this.getById(id);
    if (!item) {
      throw new NotFoundException({
        code: 'HONOR_NOT_FOUND',
        message: 'Honor item not found',
      });
    }
    return item;
  }

  async getByKey(key: string): Promise<HonorItemDocument | null> {
    return this.itemModel.findOne({ key }).exec();
  }

  async create(input: CreateHonorItemDto): Promise<HonorItemDocument> {
    const exists = await this.itemModel.exists({ key: input.key });
    if (exists) {
      throw new ConflictException({
        code: 'HONOR_KEY_TAKEN',
        message: `Honor key "${input.key}" already in use`,
      });
    }
    const tiers = (input.tiers ?? []).map((t) => ({
      name: t.name,
      iconUrl: t.iconUrl ?? '',
      svgaUrl: t.svgaUrl ?? '',
      metric: t.metric ?? HonorMetric.NONE,
      target: t.target ?? 0,
      rewardText: t.rewardText ?? '',
    }));
    // When the admin supplies a tiers array we derive maxTier from
    // it — saves them having to keep the two in sync. Falls back to
    // their explicit `maxTier` (or the legacy default) when no tiers
    // are listed.
    const maxTier = tiers.length > 0 ? tiers.length : (input.maxTier ?? 5);
    return this.itemModel.create({
      key: input.key,
      name: input.name,
      description: input.description ?? '',
      category: input.category ?? HonorCategory.SPECIAL,
      iconUrl: input.iconUrl ?? '',
      iconPublicId: input.iconPublicId ?? '',
      svgaUrl: input.svgaUrl ?? '',
      svgaPublicId: input.svgaPublicId ?? '',
      iconAssetType: input.iconAssetType ?? HonorAssetType.IMAGE,
      maxTier,
      tiers,
      sortOrder: input.sortOrder ?? 0,
      active: input.active ?? true,
    });
  }

  async update(
    id: string,
    update: UpdateHonorItemDto,
  ): Promise<HonorItemDocument> {
    const item = await this.getByIdOrThrow(id);
    if (update.name !== undefined) item.name = update.name;
    if (update.description !== undefined) item.description = update.description;
    if (update.category !== undefined) item.category = update.category;
    if (update.iconUrl !== undefined) item.iconUrl = update.iconUrl;
    if (update.iconPublicId !== undefined) {
      item.iconPublicId = update.iconPublicId;
    }
    if (update.svgaUrl !== undefined) item.svgaUrl = update.svgaUrl;
    if (update.svgaPublicId !== undefined) {
      item.svgaPublicId = update.svgaPublicId;
    }
    if (update.iconAssetType !== undefined) {
      item.iconAssetType = update.iconAssetType;
    }
    if (update.tiers !== undefined) {
      item.tiers = update.tiers.map((t) => ({
        name: t.name,
        iconUrl: t.iconUrl ?? '',
        svgaUrl: t.svgaUrl ?? '',
        metric: t.metric ?? HonorMetric.NONE,
        target: t.target ?? 0,
        rewardText: t.rewardText ?? '',
      }));
      // Re-derive maxTier from the array length to keep them in sync.
      item.maxTier = item.tiers.length > 0 ? item.tiers.length : item.maxTier;
    }
    if (update.maxTier !== undefined && (item.tiers?.length ?? 0) === 0) {
      // Only let an explicit maxTier write through when the admin
      // hasn't supplied tiers — otherwise tiers.length is the truth.
      item.maxTier = update.maxTier;
    }
    if (update.sortOrder !== undefined) item.sortOrder = update.sortOrder;
    if (update.active !== undefined) item.active = update.active;
    await item.save();
    return item;
  }

  // ============== Per-user inventory ==============

  /** Public-facing list: every honor a given user has earned, hydrated
   *  with the catalog row so the mobile UI can render the icon + name
   *  + star count in one fetch. */
  async listForUser(userId: string) {
    if (!Types.ObjectId.isValid(userId)) return { items: [] };
    const rows = await this.userHonorModel
      .find({ userId: new Types.ObjectId(userId) })
      .sort({ awardedAt: -1 })
      .populate('honorItemId')
      .lean()
      .exec();
    const items = rows
      .map((r) => {
        const item = r.honorItemId as unknown as HonorItem & {
          _id: Types.ObjectId;
          active: boolean;
        };
        if (!item || item.active === false) return null;
        return {
          id: r._id.toString(),
          honorItemId: item._id.toString(),
          key: item.key,
          name: item.name,
          description: (item as any).description ?? '',
          category: item.category,
          iconUrl: item.iconUrl ?? '',
          iconAssetType: item.iconAssetType ?? HonorAssetType.IMAGE,
          maxTier: item.maxTier,
          tier: r.tier,
          source: r.source,
          note: r.note ?? '',
          awardedAt: r.awardedAt,
          sortOrder: (item as any).sortOrder ?? 0,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    return { items };
  }

  /**
   * Grant an honor to a user. The honor is identified by either its
   * catalog `_id` or its stable `key` — admins paste from either the
   * catalog table or from internal docs without coercing ids.
   *
   * Idempotent on (userId, honorItemId): re-granting upgrades the
   * tier + bumps `awardedAt` rather than inserting a duplicate.
   * `tier` defaults to the catalog's `maxTier` (an admin saying
   * "give them this medal" usually means the full version). For
   * gradual progression the task-system path passes `tier: 1`.
   */
  async grantToUser(
    userId: string,
    dto: GrantHonorDto,
    opts: {
      source?: HonorSource;
      grantedByAdminId?: string | null;
    } = {},
  ): Promise<UserHonorDocument> {
    if (!Types.ObjectId.isValid(userId)) {
      throw new BadRequestException({
        code: 'INVALID_USER_ID',
        message: 'Invalid user id',
      });
    }
    const item = await this.resolveItem(dto.honorRef);
    if (!item.active) {
      throw new BadRequestException({
        code: 'HONOR_INACTIVE',
        message: 'Honor item is not active',
      });
    }
    const tier = Math.min(Math.max(dto.tier ?? item.maxTier, 1), item.maxTier);
    const userOid = new Types.ObjectId(userId);
    const adminOid =
      opts.grantedByAdminId && Types.ObjectId.isValid(opts.grantedByAdminId)
        ? new Types.ObjectId(opts.grantedByAdminId)
        : null;
    return this.userHonorModel
      .findOneAndUpdate(
        { userId: userOid, honorItemId: item._id },
        {
          $set: {
            tier,
            source: opts.source ?? HonorSource.ADMIN_GRANT,
            awardedBy: adminOid,
            note: dto.note ?? '',
            awardedAt: new Date(),
          },
          $setOnInsert: {
            userId: userOid,
            honorItemId: item._id,
          },
        },
        { upsert: true, new: true },
      )
      .exec() as Promise<UserHonorDocument>;
  }

  // ============== Rule-based auto-grant ==============

  /**
   * Re-evaluate one user against the rule-based catalog. For each
   * active honor that has at least one tier with a rule (metric ≠
   * NONE), pull the user's current value of that metric, walk the
   * tiers from highest target to lowest, and grant the highest
   * tier whose `target` the user meets. Idempotent — calling twice
   * with the same state is a no-op.
   *
   * `metric` filter narrows the scan to just honors whose tiers
   * reference that metric. Used by the event hooks to avoid
   * re-scanning the entire catalog when only one stat changed.
   * Pass `undefined` to scan every metric (e.g. for an admin
   * "re-evaluate" button or a periodic backfill).
   *
   * The honor's tiers don't have to share a metric — admins can
   * mix-and-match (Lv.1 = 100 followers, Lv.2 = 1000 coins
   * recharged). Each tier is checked against its own rule.
   */
  async evaluateUser(
    userId: string,
    metric?: HonorMetric,
  ): Promise<{ granted: number; upgraded: number }> {
    if (!Types.ObjectId.isValid(userId)) {
      return { granted: 0, upgraded: 0 };
    }
    const userOid = new Types.ObjectId(userId);

    // Pull the active catalog. We could narrow by `tiers.metric`
    // when a filter is supplied, but the catalog is small (tens of
    // rows) so a full scan is fine and avoids missing honors that
    // mix metrics across tiers.
    const items = await this.itemModel
      .find({ active: true })
      .lean()
      .exec();

    // Cache metric values for this evaluation so we don't re-fetch
    // the same wallet / user twice for two different honors that
    // both reference the same metric.
    const metricCache = new Map<HonorMetric, number>();
    const valueOf = async (m: HonorMetric): Promise<number> => {
      if (metricCache.has(m)) return metricCache.get(m)!;
      const v = await this.metrics.getValue(userId, m);
      metricCache.set(m, v);
      return v;
    };

    let granted = 0;
    let upgraded = 0;

    for (const item of items) {
      const tiers = (item.tiers ?? []) as HonorItem['tiers'];
      if (tiers.length === 0) continue;
      // Skip when a metric filter is supplied and none of this
      // item's tiers use that metric — saves a metric lookup.
      if (
        metric !== undefined &&
        !tiers.some((t) => t.metric === metric)
      ) {
        continue;
      }
      // Determine the highest tier the user qualifies for. Walk
      // from highest index downward so the first match wins.
      let qualifyingIdx = -1;
      let progressForQualifying = 0;
      for (let i = tiers.length - 1; i >= 0; i--) {
        const t = tiers[i];
        if (t.metric === HonorMetric.NONE) continue;
        if ((t.target ?? 0) <= 0) continue;
        const value = await valueOf(t.metric);
        if (value >= t.target) {
          qualifyingIdx = i;
          progressForQualifying = value;
          break;
        }
      }
      if (qualifyingIdx < 0) {
        // Even though they don't qualify for any tier, refresh the
        // progress on Lv.1 so the bar moves. Only fires if a row
        // already exists — we don't create empty rows for honors
        // the user hasn't reached.
        const firstRule = tiers.find(
          (t) => t.metric !== HonorMetric.NONE && (t.target ?? 0) > 0,
        );
        if (firstRule) {
          const value = await valueOf(firstRule.metric);
          await this.userHonorModel
            .updateOne(
              { userId: userOid, honorItemId: item._id },
              { $set: { progress: value } },
            )
            .exec();
        }
        continue;
      }

      const newTier = qualifyingIdx + 1; // 1-indexed
      const existing = await this.userHonorModel
        .findOne({ userId: userOid, honorItemId: item._id })
        .exec();
      if (!existing) {
        await this.userHonorModel.create({
          userId: userOid,
          honorItemId: item._id,
          tier: newTier,
          source: HonorSource.TASK,
          progress: progressForQualifying,
          awardedAt: new Date(),
        });
        granted += 1;
      } else if (existing.tier < newTier) {
        existing.tier = newTier;
        existing.source = HonorSource.TASK;
        existing.progress = progressForQualifying;
        existing.awardedAt = new Date();
        await existing.save();
        upgraded += 1;
      } else {
        // Tier unchanged but the metric value may have moved —
        // bump progress so the bar is fresh.
        if (existing.progress !== progressForQualifying) {
          existing.progress = progressForQualifying;
          await existing.save();
        }
      }
    }

    return { granted, upgraded };
  }

  /** Convenience for the task system / event hooks. Same flow as
   *  `grantToUser` but keyed off the stable `key` and tagged with
   *  `source: TASK` so audit trails distinguish auto-awards from
   *  admin actions. */
  async awardByKey(
    userId: string,
    key: string,
    tier: number,
  ): Promise<UserHonorDocument | null> {
    const item = await this.getByKey(key);
    if (!item || !item.active) return null;
    return this.grantToUser(
      userId,
      { honorRef: key, tier },
      { source: HonorSource.TASK },
    );
  }

  // ============== Wear / Unwear (Honor Wall slots) ==============

  /**
   * Wear a medal in `slot` (0..9) on the user's Honor Wall. Enforces
   * the two invariants the UI cares about:
   *
   *   1. Each slot holds at most one medal — anyone else parked in
   *      this slot gets vacated first.
   *   2. Each medal occupies at most one slot — if the user moves
   *      a medal from slot 2 to slot 5, slot 2 is freed.
   *
   * Throws 404 if the medal isn't in the user's inventory.
   */
  async wear(
    userId: string,
    userHonorId: string,
    slot: number,
  ): Promise<UserHonorDocument> {
    if (
      !Types.ObjectId.isValid(userId) ||
      !Types.ObjectId.isValid(userHonorId)
    ) {
      throw new BadRequestException({
        code: 'INVALID_ID',
        message: 'Invalid id',
      });
    }
    if (slot < 0 || slot > 9) {
      throw new BadRequestException({
        code: 'INVALID_SLOT',
        message: 'Slot must be 0..9',
      });
    }
    const userOid = new Types.ObjectId(userId);
    const owned = await this.userHonorModel.findById(userHonorId).exec();
    if (!owned || !owned.userId.equals(userOid)) {
      throw new NotFoundException({
        code: 'HONOR_NOT_OWNED',
        message: 'You don\'t hold this honor',
      });
    }
    // Free anyone else parked in this slot. The unique-on-slot
    // semantics mean this updateMany only ever touches at most one
    // doc, but using updateMany lets the DB layer atomically clear
    // any stale rows from prior bugs.
    await this.userHonorModel
      .updateMany(
        { userId: userOid, wornSlot: slot },
        { $set: { wornSlot: -1 } },
      )
      .exec();
    owned.wornSlot = slot;
    await owned.save();
    return owned;
  }

  /** Take the medal off the wall — wornSlot back to -1. Idempotent. */
  async unwear(
    userId: string,
    userHonorId: string,
  ): Promise<UserHonorDocument> {
    if (
      !Types.ObjectId.isValid(userId) ||
      !Types.ObjectId.isValid(userHonorId)
    ) {
      throw new BadRequestException({
        code: 'INVALID_ID',
        message: 'Invalid id',
      });
    }
    const owned = await this.userHonorModel.findById(userHonorId).exec();
    if (!owned || owned.userId.toString() !== userId) {
      throw new NotFoundException({
        code: 'HONOR_NOT_OWNED',
        message: 'You don\'t hold this honor',
      });
    }
    if (owned.wornSlot !== -1) {
      owned.wornSlot = -1;
      await owned.save();
    }
    return owned;
  }

  /**
   * Public read for any user — returns just the medals they have
   * worn on their Honor Wall, ordered by slot. Profile screens hit
   * this for the "wearing strip" / hero-strip display.
   */
  async listWornForUser(userId: string) {
    if (!Types.ObjectId.isValid(userId)) return { items: [] };
    const rows = await this.userHonorModel
      .find({ userId: new Types.ObjectId(userId), wornSlot: { $gte: 0 } })
      .sort({ wornSlot: 1 })
      .populate('honorItemId')
      .lean()
      .exec();
    const items = rows
      .map((r) => {
        const item = r.honorItemId as unknown as HonorItem & {
          _id: Types.ObjectId;
          active: boolean;
          tiers?: HonorItem['tiers'];
        };
        if (!item || item.active === false) return null;
        // Resolve the tier-specific icon + svga when the catalog has
        // tier metadata; falls back to the top-level pair for rows
        // without tiers.
        const tierIdx = Math.max(0, Math.min((r.tier ?? 1) - 1, (item.tiers?.length ?? 1) - 1));
        const tier = item.tiers?.[tierIdx];
        const tierIcon = tier?.iconUrl?.trim();
        const tierSvga = tier?.svgaUrl?.trim();
        // Legacy rows shipped one URL on `iconUrl` with
        // `iconAssetType: 'svga'`. Re-route to `svgaUrl` so clients
        // always see "iconUrl = static image, svgaUrl = animation".
        const normalized = this._normalizeAssets({
          iconUrl: (tierIcon && tierIcon.length > 0) ? tierIcon : item.iconUrl,
          svgaUrl: (tierSvga && tierSvga.length > 0) ? tierSvga : (item.svgaUrl ?? ''),
          iconAssetType: item.iconAssetType ?? HonorAssetType.IMAGE,
        });
        return {
          id: r._id.toString(),
          honorItemId: item._id.toString(),
          key: item.key,
          name: item.name,
          category: item.category,
          iconUrl: normalized.iconUrl,
          svgaUrl: normalized.svgaUrl,
          iconAssetType: normalized.iconAssetType,
          tier: r.tier,
          maxTier: item.maxTier,
          wornSlot: r.wornSlot,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    return { items };
  }

  /**
   * Mobile Honor Wall feed — every active catalog row, merged with
   * the caller's per-honor state (owned? what tier? worn? progress?).
   * One round-trip + one zip in code beats fetching catalog separately
   * and joining client-side, especially since the page tabs show
   * locked + unlocked together with progress on each.
   */
  async listMyHonors(userId: string) {
    const all = await this.itemModel
      .find({ active: true })
      .sort({ category: 1, sortOrder: 1, name: 1 })
      .lean()
      .exec();
    const owned = Types.ObjectId.isValid(userId)
      ? await this.userHonorModel
          .find({ userId: new Types.ObjectId(userId) })
          .lean()
          .exec()
      : [];
    const ownedByItem = new Map<string, (typeof owned)[number]>();
    for (const o of owned) ownedByItem.set(o.honorItemId.toString(), o);

    const items = all.map((item) => {
      const o = ownedByItem.get(item._id.toString());
      const tiers = (item.tiers ?? []) as HonorItem['tiers'];
      const normalized = this._normalizeAssets({
        iconUrl: item.iconUrl ?? '',
        svgaUrl: item.svgaUrl ?? '',
        iconAssetType: item.iconAssetType ?? HonorAssetType.IMAGE,
      });
      return {
        // Catalog fields
        honorItemId: item._id.toString(),
        key: item.key,
        name: item.name,
        description: item.description ?? '',
        category: item.category,
        iconUrl: normalized.iconUrl,
        svgaUrl: normalized.svgaUrl,
        iconAssetType: normalized.iconAssetType,
        maxTier: item.maxTier,
        tiers: tiers.map((t) => ({
          name: t.name,
          iconUrl: t.iconUrl ?? '',
          svgaUrl: t.svgaUrl ?? '',
          metric: t.metric ?? HonorMetric.NONE,
          target: t.target ?? 0,
          rewardText: t.rewardText ?? '',
        })),
        sortOrder: item.sortOrder ?? 0,
        // Per-user state — null when not owned
        userHonorId: o ? o._id.toString() : null,
        owned: o != null,
        tier: o?.tier ?? 0,
        progress: o?.progress ?? 0,
        wornSlot: o?.wornSlot ?? -1,
      };
    });
    return { items };
  }

  /**
   * Legacy shim: pre–dual-asset rows stored a single URL on
   * `iconUrl` with `iconAssetType: 'svga'` to mark it as animated.
   * Normalize on read so clients see the canonical pair —
   * iconUrl = static image, svgaUrl = animation. Idempotent: rows
   * that already follow the new pattern pass through unchanged.
   */
  private _normalizeAssets(input: {
    iconUrl: string;
    svgaUrl: string;
    iconAssetType: HonorAssetType;
  }): { iconUrl: string; svgaUrl: string; iconAssetType: HonorAssetType } {
    if (
      input.iconAssetType === HonorAssetType.SVGA &&
      input.svgaUrl.length === 0 &&
      input.iconUrl.length > 0
    ) {
      return {
        iconUrl: '',
        svgaUrl: input.iconUrl,
        iconAssetType: HonorAssetType.IMAGE,
      };
    }
    return input;
  }

  async revokeFromUser(
    userId: string,
    honorItemId: string,
  ): Promise<{ removed: boolean }> {
    if (
      !Types.ObjectId.isValid(userId) ||
      !Types.ObjectId.isValid(honorItemId)
    ) {
      return { removed: false };
    }
    const res = await this.userHonorModel
      .deleteOne({
        userId: new Types.ObjectId(userId),
        honorItemId: new Types.ObjectId(honorItemId),
      })
      .exec();
    return { removed: res.deletedCount > 0 };
  }

  // ============== Helpers ==============

  /** Accept either an _id or the stable `key` — admins copy from
   *  whichever surface is in front of them. */
  private async resolveItem(ref: string): Promise<HonorItemDocument> {
    const byId = Types.ObjectId.isValid(ref) ? await this.getById(ref) : null;
    if (byId) return byId;
    const byKey = await this.getByKey(ref);
    if (byKey) return byKey;
    throw new NotFoundException({
      code: 'HONOR_NOT_FOUND',
      message: `Honor "${ref}" not found`,
    });
  }
}
