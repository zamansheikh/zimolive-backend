import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type RocketRoomStateDocument = HydratedDocument<RocketRoomState>;

/** One contribution log row — kept compact so the doc stays small. */
@Schema({ _id: false })
export class RocketContribution {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId!: Types.ObjectId;

  /** Cumulative energy contributed in THIS day for the active room.
   *  Reset to 0 when the daily cron rolls the day over. */
  @Prop({ type: Number, default: 0, min: 0 })
  energy!: number;
}

export const RocketContributionSchema = SchemaFactory.createForClass(
  RocketContribution,
);

/** A historical launch event — appended to `launches` when a level's
 *  energy fills. Holds enough metadata for the rewards roster page. */
@Schema({ _id: false })
export class RocketLaunchRecord {
  @Prop({ type: Number, required: true })
  level!: number;

  @Prop({ type: Date, required: true })
  launchedAt!: Date;

  /** Top-3 contributors at the moment of launch (energy snapshotted). */
  @Prop({
    type: [
      {
        userId: { type: Types.ObjectId, ref: 'User' },
        rank: { type: Number },
        energy: { type: Number },
        coinsAwarded: { type: Number },
      },
    ],
    default: [],
  })
  topContributors!: Array<{
    userId: Types.ObjectId;
    rank: number;
    energy: number;
    coinsAwarded: number;
  }>;

  /** Random beneficiaries from the room (excluding the top-3). */
  @Prop({
    type: [
      {
        userId: { type: Types.ObjectId, ref: 'User' },
        coinsAwarded: { type: Number },
      },
    ],
    default: [],
  })
  randomBeneficiaries!: Array<{
    userId: Types.ObjectId;
    coinsAwarded: number;
  }>;
}

export const RocketLaunchRecordSchema = SchemaFactory.createForClass(
  RocketLaunchRecord,
);

/**
 * A launch the room has *committed to* but not yet fired — its winners were
 * snapshotted when the countdown started (from the audience present then),
 * and are paid out when the countdown elapses. Persisted so a server restart
 * mid-countdown still pays the right people.
 */
@Schema({ _id: false })
export class RocketPendingLaunch {
  /** Level being launched (head of the queue). */
  @Prop({ type: Number, required: true })
  level!: number;

  /** Monotonic launch sequence — drives idempotency keys + banner dedup. */
  @Prop({ type: Number, required: true })
  seq!: number;

  @Prop({
    type: [
      {
        userId: { type: Types.ObjectId, ref: 'User' },
        rank: { type: Number },
        energy: { type: Number },
        coinsAwarded: { type: Number },
      },
    ],
    default: [],
  })
  top!: Array<{
    userId: Types.ObjectId;
    rank: number;
    energy: number;
    coinsAwarded: number;
  }>;

  @Prop({
    type: [
      {
        userId: { type: Types.ObjectId, ref: 'User' },
        coinsAwarded: { type: Number },
      },
    ],
    default: [],
  })
  random!: Array<{ userId: Types.ObjectId; coinsAwarded: number }>;
}

export const RocketPendingLaunchSchema =
  SchemaFactory.createForClass(RocketPendingLaunch);

export enum RocketStatus {
  /** Energy filling toward the current level. */
  IDLE = 'idle',
  /** A level filled: global banner is out, the platform is gathering into
   *  the room. No animation yet. */
  BANNER = 'banner',
  /** Banner window elapsed: winners snapshotted, in-room countdown running
   *  (video downloading), launch fires when it elapses. */
  COUNTDOWN = 'countdown',
  /** Legacy stuck state from before the queue model. Treated as IDLE. */
  COMPLETE = 'complete',
}

/**
 * Per-(room, day) rocket state. The (roomId, dayKey) unique index makes
 * each row the canonical "today's rocket" for one room — cron rolls the
 * day over, the next gift creates a fresh row via the upsert in
 * `addEnergy`.
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
export class RocketRoomState {
  @Prop({ type: Types.ObjectId, ref: 'Room', required: true, index: true })
  roomId!: Types.ObjectId;

  /** yyyy-MM-dd in the configured timezone. */
  @Prop({ type: String, required: true, index: true })
  dayKey!: string;

  /** 1..maxLevel. The level currently being filled. */
  @Prop({ type: Number, default: 1, min: 1 })
  currentLevel!: number;

  /** Energy accumulated toward `currentLevel`. Resets to 0 on launch. */
  @Prop({ type: Number, default: 0, min: 0 })
  currentEnergy!: number;

  @Prop({ type: String, enum: RocketStatus, default: RocketStatus.IDLE })
  status!: RocketStatus;

  /**
   * Levels resolved from fuel and waiting to launch, in order — the head is
   * the one currently in BANNER/COUNTDOWN. One big gift fills several levels
   * at once; they fire one at a time (see rocket-system.md §7). Empty when
   * IDLE.
   */
  @Prop({ type: [Number], default: [] })
  launchQueue!: number[];

  /**
   * When the CURRENT phase (BANNER or COUNTDOWN) started. The cron sweeper
   * advances the phase once `phaseStartedAt + phaseDuration` has elapsed.
   * Null when IDLE.
   */
  @Prop({ type: Date, default: null })
  phaseStartedAt?: Date | null;

  /**
   * Winners snapshotted at COUNTDOWN start (from the audience present then),
   * paid out when the countdown elapses. Null outside an active countdown.
   */
  @Prop({ type: RocketPendingLaunchSchema, default: null })
  pendingLaunch?: RocketPendingLaunch | null;

  /**
   * Monotonic counter for launch sequences — every launch (including loops
   * of the same level) gets a distinct seq so reward idempotency keys and
   * banner dedup never collide across the day.
   */
  @Prop({ type: Number, default: 0, min: 0 })
  launchSeq!: number;

  /**
   * Legacy field from the pre-queue model. Kept so old rows deserialize;
   * no longer written. Superseded by `phaseStartedAt`.
   */
  @Prop({ type: Date, default: null })
  countdownStartedAt?: Date | null;

  /**
   * Per-user energy contributed today — drives the top-3 ranking AND
   * the random-beneficiary picker (which draws only from active
   * contributors, not random idle viewers). Capped to ~few hundred
   * entries in practice; rooms with thousands of distinct contributors
   * per day would need pagination.
   */
  @Prop({ type: [RocketContributionSchema], default: [] })
  contributions!: RocketContribution[];

  /** History of every launch the rocket made today. */
  @Prop({ type: [RocketLaunchRecordSchema], default: [] })
  launches!: RocketLaunchRecord[];
}

export const RocketRoomStateSchema =
  SchemaFactory.createForClass(RocketRoomState);

RocketRoomStateSchema.index({ roomId: 1, dayKey: 1 }, { unique: true });
RocketRoomStateSchema.index({ status: 1, countdownStartedAt: 1 });
