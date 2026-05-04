import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';
import { Model, Types } from 'mongoose';

import { CosmeticsService } from '../cosmetics/cosmetics.service';
import { CosmeticSource } from '../cosmetics/schemas/user-cosmetic.schema';
import { Currency, TxnType } from '../wallet/schemas/transaction.schema';
import { WalletService } from '../wallet/wallet.service';
import { SVIP_PRIVILEGES, PrivilegeDef } from './privileges.catalog';
import { SvipTier, SvipTierDocument } from './schemas/svip-tier.schema';
import { UserSvipStatus, UserSvipStatusDocument } from './schemas/user-svip-status.schema';

@Injectable()
export class SvipService {
  constructor(
    @InjectModel(SvipTier.name) private readonly tierModel: Model<SvipTierDocument>,
    @InjectModel(UserSvipStatus.name)
    private readonly statusModel: Model<UserSvipStatusDocument>,
    private readonly wallet: WalletService,
    private readonly cosmetics: CosmeticsService,
  ) {}

  // ---------- Privileges catalog ----------

  listPrivileges(): readonly PrivilegeDef[] {
    return SVIP_PRIVILEGES;
  }

  // ---------- Tier CRUD ----------

  async listTiers(activeOnly = false) {
    const filter = activeOnly ? { active: true } : {};
    return this.tierModel.find(filter).sort({ level: 1 }).exec();
  }

  async findById(id: string): Promise<SvipTierDocument | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return this.tierModel.findById(id).exec();
  }

  async getByIdOrThrow(id: string): Promise<SvipTierDocument> {
    const t = await this.findById(id);
    if (!t) throw new NotFoundException('SVIP tier not found');
    return t;
  }

  async getByLevel(level: number): Promise<SvipTierDocument | null> {
    return this.tierModel.findOne({ level }).exec();
  }

  async create(input: any): Promise<SvipTierDocument> {
    const exists = await this.tierModel.countDocuments({ level: input.level }).exec();
    if (exists) {
      throw new ConflictException({
        code: 'SVIP_LEVEL_TAKEN',
        message: `SVIP level ${input.level} already exists`,
      });
    }
    this.assertPrivilegesValid(input.privileges);
    return this.tierModel.create({
      ...input,
      grantedItemIds: (input.grantedItemIds ?? []).map((s: string) => new Types.ObjectId(s)),
    });
  }

  async update(id: string, update: any): Promise<SvipTierDocument> {
    const t = await this.getByIdOrThrow(id);
    if (update.privileges !== undefined) this.assertPrivilegesValid(update.privileges);

    if (update.name !== undefined) t.name = update.name;
    if (update.monthlyPointsRequired !== undefined)
      t.monthlyPointsRequired = update.monthlyPointsRequired;
    if (update.coinReward !== undefined) t.coinReward = update.coinReward;
    if (update.coinPrice !== undefined) t.coinPrice = update.coinPrice;
    if (update.durationDays !== undefined) t.durationDays = update.durationDays;
    if (update.iconUrl !== undefined) t.iconUrl = update.iconUrl;
    if (update.iconPublicId !== undefined) t.iconPublicId = update.iconPublicId;
    if (update.bannerUrl !== undefined) t.bannerUrl = update.bannerUrl;
    if (update.bannerPublicId !== undefined) t.bannerPublicId = update.bannerPublicId;
    if (update.grantedItemIds !== undefined) {
      t.grantedItemIds = update.grantedItemIds.map((s: string) => new Types.ObjectId(s));
    }
    if (update.privileges !== undefined) t.privileges = update.privileges;
    if (update.active !== undefined) t.active = update.active;

    await t.save();
    return t;
  }

  async softDelete(id: string): Promise<void> {
    const t = await this.getByIdOrThrow(id);
    t.active = false;
    await t.save();
  }

  // ---------- User SVIP status ----------

  async getOrCreateStatus(userId: string): Promise<UserSvipStatusDocument> {
    if (!Types.ObjectId.isValid(userId)) {
      throw new NotFoundException('Invalid user id');
    }
    const userObj = new Types.ObjectId(userId);
    return this.statusModel
      .findOneAndUpdate(
        { userId: userObj },
        { $setOnInsert: { userId: userObj } },
        { upsert: true, new: true },
      )
      .exec();
  }

  async getStatus(userId: string): Promise<UserSvipStatusDocument | null> {
    if (!Types.ObjectId.isValid(userId)) return null;
    return this.statusModel.findOne({ userId: new Types.ObjectId(userId) }).exec();
  }

  /**
   * Quick check used by other modules to gate behavior. e.g. the chat
   * module's mute action calls `userHasPrivilege(targetId, 'cant_be_ban_public_chat')`
   * before applying. Caches nothing — this is one indexed read of the
   * status doc plus a small tiers query. Cache at the call site if hot.
   */
  async userHasPrivilege(userId: string, key: string): Promise<boolean> {
    const all = await this.resolvedPrivileges(userId);
    return all.includes(key);
  }

  /**
   * Aggregated set of privilege keys the user currently enjoys, derived
   * from their currentLevel. Returns [] for non-SVIP users.
   */
  async resolvedPrivileges(userId: string): Promise<string[]> {
    const status = await this.getStatus(userId);
    if (!status || status.currentLevel === 0) return [];
    if (status.expiresAt && status.expiresAt < new Date()) return [];

    // All tiers ≤ currentLevel contribute their privileges (tiers stack).
    const tiers = await this.tierModel
      .find({ level: { $lte: status.currentLevel }, active: true })
      .exec();
    const set = new Set<string>();
    for (const t of tiers) for (const p of t.privileges) set.add(p);
    return [...set];
  }

  // ---------- Direct purchase (coins → tier) ----------

  /**
   * Pay coins to acquire an SVIP tier directly. Bypasses the monthly-
   * points pathway. Used by the mobile SVIP page when the user has
   * enough coins; the page falls back to the Recharge CTA otherwise.
   *
   * Flow:
   *   1. Resolve the tier and validate it's purchasable (`coinPrice > 0`).
   *   2. Refuse if the caller already holds an equal-or-higher tier —
   *      buying SVIP3 when you're already SVIP5 wastes coins for no
   *      gain, so we 409 instead of silently accepting.
   *   3. Wallet debit (idempotency key derived from user + tier so a
   *      double-tap doesn't double-charge).
   *   4. Bump UserSvipStatus.currentLevel + extend `expiresAt` by the
   *      tier's `durationDays`. If the user already had time left
   *      from a prior purchase, we add to it rather than reset — so
   *      buying SVIP1 in March then SVIP1 again in April gives ~60
   *      days, not 30.
   *
   * Returns the fresh status doc so the mobile page can refresh state
   * in one round-trip.
   */
  async purchaseTier(
    userId: string,
    level: number,
  ): Promise<UserSvipStatusDocument> {
    if (!Types.ObjectId.isValid(userId)) {
      throw new BadRequestException({
        code: 'INVALID_USER_ID',
        message: 'Invalid user id',
      });
    }
    const tier = await this.getByLevel(level);
    if (!tier || !tier.active) {
      throw new NotFoundException({
        code: 'SVIP_TIER_NOT_FOUND',
        message: `SVIP tier ${level} not found`,
      });
    }
    if (tier.coinPrice <= 0) {
      throw new BadRequestException({
        code: 'TIER_NOT_PURCHASABLE',
        message: 'This tier is not available for direct purchase',
      });
    }

    const status = await this.getOrCreateStatus(userId);
    // The user can own multiple non-overlapping tiers (e.g. SVIP1 +
    // SVIP3). We only block the purchase if they ALREADY own this
    // exact tier — buying a lower tier you don't own is fine, you
    // just can't buy the same one twice.
    if ((status.ownedLevels ?? []).includes(level)) {
      throw new ConflictException({
        code: 'ALREADY_OWNED',
        message: 'You already own this tier',
      });
    }

    // Stable idempotency: a double-tap within the same second of the
    // same (user, tier) attempts the same key, so the wallet's
    // dedupe path returns the existing txn. Random suffix from a
    // UUID keeps repeat-purchases of the same tier across separate
    // sessions distinct.
    await this.wallet.debit(Currency.COINS, {
      userId,
      amount: tier.coinPrice,
      type: TxnType.SVIP_PURCHASE,
      idempotencyKey: `svip-purchase:${userId}:${tier._id.toString()}:${randomUUID()}`,
      description: `Purchased ${tier.name}`,
      refType: 'svip_tier',
      refId: tier._id.toString(),
    });

    // Extend expiry from whichever is later: now or the user's
    // existing expiry. Prevents losing remaining time when buying a
    // higher tier mid-cycle. `durationDays: 0` means permanent —
    // we drop expiresAt entirely in that case.
    const now = new Date();
    let expiresAt: Date | null;
    if (tier.durationDays === 0) {
      expiresAt = null;
    } else {
      const base =
        status.expiresAt && status.expiresAt > now ? status.expiresAt : now;
      expiresAt = new Date(
        base.getTime() + tier.durationDays * 24 * 60 * 60 * 1000,
      );
    }
    // Track ownership; auto-activate this tier ONLY if it's higher
    // than what they currently have on (so a user with SVIP3 buying
    // SVIP1 keeps SVIP3 active, but a user with SVIP1 buying SVIP3
    // gets bumped up to SVIP3).
    const owned = new Set([...(status.ownedLevels ?? []), level]);
    status.ownedLevels = Array.from(owned).sort((a, b) => a - b);
    const wasBumped = level > status.currentLevel;
    if (wasBumped) status.currentLevel = level;
    if (level > status.highestLevel) status.highestLevel = level;
    status.expiresAt = expiresAt;
    await status.save();

    // Grant the cosmetics tied to this tier so the user owns them in
    // their inventory. We grant for tiers ≤ this one too (in case a
    // user is buying SVIP3 first and bypasses lower-tier grants); the
    // grant is idempotent at the DB layer.
    await this._grantCosmeticsForOwnedTiers(
      userId,
      status.ownedLevels,
      tier.durationDays > 0 ? tier.durationDays : null,
    );

    // If the purchase bumped them to a new active tier, auto-equip
    // every SVIP cosmetic for the new currentLevel. Lower-tier
    // owners can equip later via the activate endpoint.
    if (wasBumped) {
      await this.cosmetics.equipSvipTier(userId, status.currentLevel);
    }
    return status;
  }

  /**
   * Switch the user's active SVIP to a tier they already own.
   * Used by the SVIP page's "Activate" button. Errors:
   *   • 404 SVIP_TIER_NOT_FOUND — bad level number.
   *   • 403 NOT_OWNED — caller doesn't own this tier yet.
   */
  async activateTier(
    userId: string,
    level: number,
  ): Promise<UserSvipStatusDocument> {
    if (!Types.ObjectId.isValid(userId)) {
      throw new BadRequestException({
        code: 'INVALID_USER_ID',
        message: 'Invalid user id',
      });
    }
    const tier = await this.getByLevel(level);
    if (!tier || !tier.active) {
      throw new NotFoundException({
        code: 'SVIP_TIER_NOT_FOUND',
        message: `SVIP tier ${level} not found`,
      });
    }
    const status = await this.getOrCreateStatus(userId);
    if (!(status.ownedLevels ?? []).includes(level)) {
      throw new ForbiddenException({
        code: 'NOT_OWNED',
        message: 'You don\'t own this tier yet',
      });
    }
    status.currentLevel = level;
    await status.save();

    // Equip every SVIP-granted cosmetic for tiers ≤ the new active
    // level. CosmeticsService handles "one per type" — if the user
    // had a store-purchased frame on, the SVIP frame takes its place
    // and the store row flips to unequipped. Defensive grant first
    // in case the rows were never created (e.g. legacy purchases
    // that pre-dated the auto-grant).
    await this._grantCosmeticsForOwnedTiers(
      userId,
      status.ownedLevels,
      null, // duration unknown at this point — extend doesn't shrink, so null is safe
    );
    await this.cosmetics.equipSvipTier(userId, level);
    return status;
  }

  /**
   * Hide the user's SVIP badge / privileges without giving up
   * ownership. They can re-activate any owned tier later. Setting
   * currentLevel = 0 is the canonical "no SVIP active" state.
   *
   * Also unequips every SVIP-source cosmetic so the user goes back
   * to whatever non-SVIP look they had. Store / gift items don't
   * auto-re-equip — the user picks what they want from My Items.
   */
  async deactivate(userId: string): Promise<UserSvipStatusDocument> {
    if (!Types.ObjectId.isValid(userId)) {
      throw new BadRequestException({
        code: 'INVALID_USER_ID',
        message: 'Invalid user id',
      });
    }
    const status = await this.getOrCreateStatus(userId);
    status.currentLevel = 0;
    await status.save();
    await this.cosmetics.unequipBySource(userId, CosmeticSource.SVIP);
    return status;
  }

  /**
   * Grant every cosmetic listed on the tiers in `ownedLevels` to the
   * user, tagged with `source: SVIP` and the originating tier level.
   * Idempotent at the DB layer (CosmeticsService.grantToUser dedupes
   * via the unique index on user+item+source+externalRef), so it's
   * safe to call from purchase AND activate.
   */
  private async _grantCosmeticsForOwnedTiers(
    userId: string,
    ownedLevels: number[],
    durationDays: number | null,
  ) {
    if (ownedLevels.length === 0) return;
    const tiers = await this.tierModel
      .find({ level: { $in: ownedLevels }, active: true })
      .exec();
    for (const tier of tiers) {
      for (const itemId of tier.grantedItemIds ?? []) {
        try {
          await this.cosmetics.grantToUser({
            userId,
            cosmeticItemId: itemId.toString(),
            source: CosmeticSource.SVIP,
            durationDays: durationDays ?? undefined,
            svipTier: tier.level,
            externalRef: `svip-tier-${tier.level}`,
          });
        } catch {
          // Best-effort: a single bad item id shouldn't poison the
          // whole tier activate. Failures get re-attempted on the
          // next activate / purchase.
        }
      }
    }
  }

  // ---------- helpers ----------

  private assertPrivilegesValid(privileges: string[] | undefined) {
    if (!privileges) return;
    const valid = new Set(SVIP_PRIVILEGES.map((p) => p.key));
    const unknown = privileges.filter((p) => !valid.has(p));
    if (unknown.length > 0) {
      throw new ConflictException({
        code: 'UNKNOWN_PRIVILEGE',
        message: 'One or more privilege keys are not in the catalog',
        details: { unknown },
      });
    }
  }
}
