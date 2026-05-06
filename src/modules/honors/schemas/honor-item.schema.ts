import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type HonorItemDocument = HydratedDocument<HonorItem>;

/// Categorical bucket the badge belongs to. Drives the tab strip on
/// the Honor Wall page (Fortune / Connection / Gift / Experience /
/// Constellation / Special / …) and the admin catalog filter
/// dropdown. Old buckets (medal/charm/wealth/event) are kept so any
/// rows created before this expansion still render — they just show
/// up on a hidden "legacy" tab unless the admin re-tags them.
export enum HonorCategory {
  /// Wealth / coin-spend / recharge-driven medals (Billionaire, Big
  /// Spender, Monthly Supporter).
  FORTUNE = 'fortune',
  /// Relationship-driven medals (CP levels, follower counts).
  CONNECTION = 'connection',
  /// Gift-driven medals (specific gifts sent / received milestones).
  GIFT = 'gift',
  /// Activity / level / experience medals (level, hours streamed,
  /// games won).
  EXPERIENCE = 'experience',
  /// Time-of-year / themed / event medals (tournaments, holidays).
  CONSTELLATION = 'constellation',
  /// Curated / hand-picked staff honors that don't fit a bucket.
  SPECIAL = 'special',
  // ---- Legacy values, kept for backwards compatibility ----
  MEDAL = 'medal',
  CHARM = 'charm',
  WEALTH = 'wealth',
  EVENT = 'event',
}

/// What kind of asset the icon is. Drives the renderer on the
/// mobile side: static images go through CachedNetworkImage; SVGA
/// goes through the SVGA player so the badge animates. Defaults to
/// IMAGE for backwards compat with rows created before SVGA shipped.
export enum HonorAssetType {
  IMAGE = 'image',
  SVGA = 'svga',
}

/**
 * Metric that determines whether a user has unlocked a given tier.
 * Each tier carries `(metric, target)`; the evaluator grants the
 * highest tier whose `target` the user's current metric value
 * meets. `none` skips the auto-grant pathway entirely — admins
 * still grant manually for those.
 */
export enum HonorMetric {
  /// No auto-rule. Admin grants manually only.
  NONE = 'none',
  /// Account level (User.level).
  LEVEL = 'level',
  /// Lifetime XP earned (User.xp).
  XP = 'xp',
  /// Followers count (User.followersCount).
  FOLLOWERS = 'followers',
  /// People the user follows (User.followingCount).
  FOLLOWING = 'following',
  /// Lifetime coins purchased / minted into the wallet
  /// (Wallet.lifetimeCoinsRecharged).
  COINS_RECHARGED = 'coins_recharged',
  /// Lifetime coins spent on gifts (Wallet.lifetimeCoinsSpent).
  COINS_SENT = 'coins_sent',
  /// Lifetime diamonds earned from received gifts
  /// (Wallet.lifetimeDiamondsEarned).
  DIAMONDS_RECEIVED = 'diamonds_received',
  /// SVIP currentLevel from UserSvipStatus.
  SVIP_TIER = 'svip_tier',
}

/**
 * Catalog row for one honor / achievement badge.
 *
 * Honors are tiered (1..maxTier stars). The icon stays the same;
 * only the visible star count below it changes as a user upgrades.
 * In-app earning rules (sent N coins → bump tier) live outside this
 * schema — those are computed by the task system or set explicitly
 * by an admin grant.
 */
@Schema({
  timestamps: true,
  toJSON: {
    transform: (_doc, ret: Record<string, any>) => {
      ret.id = ret._id?.toString();
      delete ret._id;
      delete ret.__v;
      return ret;
    },
  },
})
export class HonorItem {
  /** Stable machine key (e.g. `charm_star`, `lv8`). Used by the task
   *  system to award without coupling to display name changes. */
  @Prop({ type: String, required: true, unique: true, trim: true, index: true })
  key!: string;

  /** Display name shown under the badge (e.g. "Charm Star"). */
  @Prop({ type: String, required: true, trim: true, maxlength: 60 })
  name!: string;

  @Prop({ type: String, default: '', maxlength: 300 })
  description!: string;

  @Prop({ type: String, enum: HonorCategory, default: HonorCategory.SPECIAL, index: true })
  category!: HonorCategory;

  /** Cloudinary URL for the static-image icon. Always an image
   *  going forward — used for the Honor Wall grid tile and any
   *  surface where an animation would be wasteful. */
  @Prop({ type: String, default: '' })
  iconUrl!: string;

  @Prop({ type: String, default: '' })
  iconPublicId!: string;

  /** Optional SVGA animation URL — rendered on the medal detail
   *  sheet (and other "hero" surfaces) when set. Empty string falls
   *  back to `iconUrl`. Coexists with `iconUrl` so admins can ship
   *  a static thumbnail + an animated showcase from the same row. */
  @Prop({ type: String, default: '' })
  svgaUrl!: string;

  @Prop({ type: String, default: '' })
  svgaPublicId!: string;

  /** Legacy field — kept for backwards compatibility. New rows set
   *  this to `image`; old `svga` rows are normalized in the service
   *  read path so the URL flows out as `svgaUrl` to the client. */
  @Prop({
    type: String,
    enum: HonorAssetType,
    default: HonorAssetType.IMAGE,
  })
  iconAssetType!: HonorAssetType;

  /** Number of upgrade tiers this honor supports — 1..10 stars. The
   *  current tier of a user is stored on UserHonor.tier. Populated
   *  automatically when `tiers` is provided (uses tiers.length). */
  @Prop({ type: Number, default: 5, min: 1, max: 10 })
  maxTier!: number;

  /**
   * Per-tier definitions. Each entry describes one level of this
   * medal: its display name (e.g. "Lv.1"), the variant icon at that
   * level, the numeric target the user has to hit to earn it, and
   * the human-readable reward string (e.g. "Receive gifts worth
   * 5,000,000,000 coins"). Mobile reads this to render the level-by-
   * level progress card from the screenshots.
   *
   * Empty array means the medal is single-tier — `maxTier` controls
   * the star count but no per-tier metadata exists. The grant flow
   * still works either way.
   */
  @Prop({
    type: [
      {
        name: { type: String, required: true, maxlength: 40 },
        iconUrl: { type: String, default: '' },
        svgaUrl: { type: String, default: '' },
        metric: {
          type: String,
          enum: HonorMetric,
          default: HonorMetric.NONE,
        },
        target: { type: Number, default: 0, min: 0 },
        rewardText: { type: String, default: '', maxlength: 200 },
        _id: false,
      },
    ],
    default: [],
  })
  tiers!: Array<{
    name: string;
    iconUrl: string;
    svgaUrl: string;
    metric: HonorMetric;
    target: number;
    rewardText: string;
  }>;

  /** Lower numbers come first on the mobile profile + admin list. */
  @Prop({ type: Number, default: 0 })
  sortOrder!: number;

  /** Inactive items are kept for audit but hidden from the catalog
   *  and from any user profile. */
  @Prop({ type: Boolean, default: true, index: true })
  active!: boolean;
}

export const HonorItemSchema = SchemaFactory.createForClass(HonorItem);
HonorItemSchema.index({ category: 1, sortOrder: 1 });
