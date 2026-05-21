import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type RocketConfigDocument = HydratedDocument<RocketConfig>;

/**
 * One row in the rocket reward ladder. Energy fills as users gift in
 * the room (1 coin = 1 energy); when `energyRequired` is reached the
 * fighter launches, rewards distribute, and the next level's row
 * becomes active.
 *
 * Fixed top-1/2/3 rewards go to the highest contributors *who exceeded
 * the threshold*. The random in-room pool is split across N randomly
 * picked active room members.
 *
 * `assetUrl` is just a string for v1 — admin pastes a Cloudinary URL.
 * Per-level upload UX lands in Phase 2.
 */
@Schema({ _id: false })
export class RocketLevel {
  @Prop({ type: Number, required: true, min: 1 })
  level!: number;

  /** Total energy that has to accumulate to launch THIS level. */
  @Prop({ type: Number, required: true, min: 1 })
  energyRequired!: number;

  /** Fixed coin rewards for the top-3 contributors. */
  @Prop({ type: Number, required: true, min: 0 })
  top1Coins!: number;

  @Prop({ type: Number, required: true, min: 0 })
  top2Coins!: number;

  @Prop({ type: Number, required: true, min: 0 })
  top3Coins!: number;

  /**
   * Total coin pool split across [randomBeneficiaries] randomly picked
   * active room members (excluding the top-3, who already won fixed
   * rewards).
   */
  @Prop({ type: Number, required: true, min: 0 })
  randomPoolCoins!: number;

  @Prop({ type: Number, required: true, min: 0 })
  randomBeneficiaries!: number;

  /** Cloudinary URL to the launch animation for THIS level. Optional. */
  @Prop({ type: String, default: '' })
  assetUrl!: string;

  /** Static thumbnail used in the level-strip on the side of the page. */
  @Prop({ type: String, default: '' })
  iconUrl!: string;
}

export const RocketLevelSchema = SchemaFactory.createForClass(RocketLevel);

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
export class RocketConfig {
  @Prop({ type: String, required: true, unique: true, default: 'singleton' })
  key!: string;

  @Prop({ type: Boolean, default: true })
  enabled!: boolean;

  /**
   * IANA timezone the daily reset snaps to. Bangladesh = +05:30, so the
   * default is Asia/Dhaka — matches the in-app rules screen ("Fighter
   * energy will be reset at 00:00 every day").
   */
  @Prop({ type: String, default: 'Asia/Dhaka' })
  timezone!: string;

  /**
   * Min energy a top-3 contributor must have donated to qualify for
   * the fixed reward. Mirrors the in-app rule: "the energy increased by
   * this user must be more than 120,000 coins". Below threshold = no
   * fixed reward, the slot is forfeit.
   */
  @Prop({ type: Number, default: 120_000, min: 0 })
  topContributionThreshold!: number;

  /**
   * BANNER phase length: how long the global banner gathers the platform
   * into the room BEFORE the in-room countdown starts (rocket-system.md §7).
   * No animation plays during this window. Default 10s.
   */
  @Prop({ type: Number, default: 10, min: 3, max: 60 })
  bannerSeconds!: number;

  /**
   * COUNTDOWN phase length: the in-room countdown after the banner, during
   * which the launch video downloads so playback is smooth. The animation
   * fires when it elapses. Default 15s. (Clients also wait for the download
   * to finish, so this should comfortably cover a normal video fetch.)
   */
  @Prop({ type: Number, default: 15, min: 1, max: 120 })
  launchCountdownSeconds!: number;

  /**
   * @deprecated Pre-queue model. Stacked launches now run as a strict
   * sequential queue (each fully finishes before the next banner), so there
   * is no fixed cascade gap. Kept so existing config rows deserialize.
   */
  @Prop({ type: Number, default: 30, min: 5, max: 300 })
  cascadeDelaySeconds!: number;

  @Prop({ type: [RocketLevelSchema], default: [] })
  levels!: RocketLevel[];
}

export const RocketConfigSchema = SchemaFactory.createForClass(RocketConfig);
