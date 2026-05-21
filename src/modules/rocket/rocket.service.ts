import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { RealtimeService } from '../realtime/realtime.service';
import { RealtimeEventType } from '../realtime/realtime.types';
import {
  RoomMember,
  RoomMemberDocument,
} from '../rooms/schemas/room-member.schema';
import { Room, RoomDocument } from '../rooms/schemas/room.schema';
import { User, UserDocument } from '../users/schemas/user.schema';
import { Currency, TxnType } from '../wallet/schemas/transaction.schema';
import { WalletService } from '../wallet/wallet.service';
import {
  RocketConfig,
  RocketConfigDocument,
  RocketLevel,
} from './schemas/rocket-config.schema';
import {
  RocketRoomState,
  RocketRoomStateDocument,
  RocketStatus,
} from './schemas/rocket-room-state.schema';

/**
 * Asia/Dhaka is UTC+05:30 with no DST. Same convention as Magic Ball
 * and Room Support — keeps day boundaries deterministic.
 */
const TZ_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const SINGLETON_KEY = 'singleton';

/**
 * A RoomMember counts as "present" for winner selection if its heartbeat is
 * newer than this. Rows are removed on leave, so this just drops crashed /
 * zombie clients — the live audience the banner gathered.
 */
const PRESENCE_WINDOW_MS = 5 * 60 * 1000;

const DEFAULT_LEVELS: RocketLevel[] = [
  {
    level: 1,
    energyRequired: 100_000,
    top1Coins: 50_000,
    top2Coins: 20_000,
    top3Coins: 10_000,
    randomPoolCoins: 20_000,
    randomBeneficiaries: 10,
    assetUrl: '',
    iconUrl: '',
  },
  {
    level: 2,
    energyRequired: 300_000,
    top1Coins: 150_000,
    top2Coins: 60_000,
    top3Coins: 30_000,
    randomPoolCoins: 60_000,
    randomBeneficiaries: 15,
    assetUrl: '',
    iconUrl: '',
  },
  {
    level: 3,
    energyRequired: 1_000_000,
    top1Coins: 500_000,
    top2Coins: 200_000,
    top3Coins: 100_000,
    randomPoolCoins: 200_000,
    randomBeneficiaries: 20,
    assetUrl: '',
    iconUrl: '',
  },
];

@Injectable()
export class RocketService {
  private readonly log = new Logger('RocketService');

  constructor(
    @InjectModel(RocketConfig.name)
    private readonly configModel: Model<RocketConfigDocument>,
    @InjectModel(RocketRoomState.name)
    private readonly stateModel: Model<RocketRoomStateDocument>,
    @InjectModel(Room.name) private readonly roomModel: Model<RoomDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(RoomMember.name)
    private readonly memberModel: Model<RoomMemberDocument>,
    private readonly wallet: WalletService,
    private readonly realtime: RealtimeService,
  ) {}

  // ============================================================
  // Config
  // ============================================================

  async getConfig(): Promise<RocketConfigDocument> {
    return this.configModel
      .findOneAndUpdate(
        { key: SINGLETON_KEY },
        {
          $setOnInsert: {
            key: SINGLETON_KEY,
            enabled: true,
            timezone: 'Asia/Dhaka',
            topContributionThreshold: 120_000,
            bannerSeconds: 10,
            launchCountdownSeconds: 15,
            cascadeDelaySeconds: 30,
            levels: DEFAULT_LEVELS,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      .exec();
  }

  async updateConfig(update: {
    enabled?: boolean;
    timezone?: string;
    topContributionThreshold?: number;
    bannerSeconds?: number;
    launchCountdownSeconds?: number;
    cascadeDelaySeconds?: number;
    /** assetUrl + iconUrl optional on input — server falls back to ''. */
    levels?: Array<
      Omit<RocketLevel, 'assetUrl' | 'iconUrl'> & {
        assetUrl?: string;
        iconUrl?: string;
      }
    >;
  }): Promise<RocketConfigDocument> {
    if (update.levels !== undefined) {
      // Sort + sanity-check the level numbers and rewards.
      const seen = new Set<number>();
      for (const lv of update.levels) {
        if (!Number.isInteger(lv.level) || lv.level < 1) {
          throw new BadRequestException({
            code: 'INVALID_LEVEL',
            message: `Level must be a positive integer (got ${lv.level})`,
          });
        }
        if (seen.has(lv.level)) {
          throw new BadRequestException({
            code: 'DUPLICATE_LEVEL',
            message: `Level ${lv.level} listed twice`,
          });
        }
        seen.add(lv.level);
        if (lv.energyRequired < 1) {
          throw new BadRequestException({
            code: 'INVALID_ENERGY',
            message: `Level ${lv.level}: energyRequired must be >= 1`,
          });
        }
      }
    }

    const set: Record<string, unknown> = {};
    if (update.enabled !== undefined) set.enabled = update.enabled;
    if (update.timezone !== undefined) set.timezone = update.timezone;
    if (update.topContributionThreshold !== undefined) {
      set.topContributionThreshold = update.topContributionThreshold;
    }
    if (update.bannerSeconds !== undefined) {
      set.bannerSeconds = update.bannerSeconds;
    }
    if (update.launchCountdownSeconds !== undefined) {
      set.launchCountdownSeconds = update.launchCountdownSeconds;
    }
    if (update.cascadeDelaySeconds !== undefined) {
      set.cascadeDelaySeconds = update.cascadeDelaySeconds;
    }
    if (update.levels !== undefined) {
      set.levels = [...update.levels].sort((a, b) => a.level - b.level);
    }

    return this.configModel
      .findOneAndUpdate(
        { key: SINGLETON_KEY },
        { $set: set, $setOnInsert: { key: SINGLETON_KEY } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      .exec();
  }

  // ============================================================
  // Read state
  // ============================================================

  /**
   * Today's rocket state for one room. Lazy-creates the row at level 1
   * if there's no entry yet, so the mobile page always has data to
   * render even before the first gift lands.
   */
  async getState(roomId: string): Promise<RocketRoomStateDocument | null> {
    if (!Types.ObjectId.isValid(roomId)) return null;
    const dayKey = this.getDayKey(new Date());
    // Populate the User refs on every userId in the contribution +
    // launch records so the mobile page can render real names + avatars
    // without falling back to "User <last-4-of-id>". Lean populate
    // keeps this cheap — typically a few dozen user docs per state row.
    return this.stateModel
      .findOneAndUpdate(
        { roomId: new Types.ObjectId(roomId), dayKey },
        {
          $setOnInsert: {
            roomId: new Types.ObjectId(roomId),
            dayKey,
            currentLevel: 1,
            currentEnergy: 0,
            status: RocketStatus.IDLE,
            contributions: [],
            launches: [],
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      .populate('contributions.userId', 'username displayName avatarUrl numericId')
      .populate(
        'launches.topContributors.userId',
        'username displayName avatarUrl numericId',
      )
      .populate(
        'launches.randomBeneficiaries.userId',
        'username displayName avatarUrl numericId',
      )
      .exec();
  }

  // ============================================================
  // Energy hook — called from GiftsService.sendGift
  // ============================================================

  /**
   * Add energy when a gift is sent in a room (1 coin = 1 energy). The
   * write is atomic on the per-(room, day) doc so concurrent gifts
   * never lose contributions.
   *
   * If the increment crosses `energyRequired` for the current level, we
   * flip status → COUNTDOWN and broadcast LUCKY_BAG_FULL... no wait,
   * ROOM_ROCKET_LAUNCH-style banner — receivers render the 10s
   * countdown. The cron sweeper picks it up and fires the actual
   * launch + reward distribution after the configured delay.
   *
   * Failures are swallowed by the caller (gift sends never fail
   * because rocket-tracking failed) so this method must not throw on
   * normal paths.
   */
  async addEnergy(
    roomId: string,
    senderId: string,
    energyDelta: number,
  ): Promise<void> {
    if (energyDelta <= 0) return;
    if (!Types.ObjectId.isValid(roomId) || !Types.ObjectId.isValid(senderId)) {
      this.log.warn(
        `addEnergy skipped — bad ids (roomId=${roomId}, senderId=${senderId})`,
      );
      return;
    }

    const config = await this.getConfig();
    if (!config.enabled || config.levels.length === 0) {
      this.log.debug(
        `addEnergy skipped — feature disabled or no levels configured`,
      );
      return;
    }
    this.log.debug(
      `addEnergy room=${roomId} sender=${senderId} delta=${energyDelta}`,
    );

    const dayKey = this.getDayKey(new Date());
    const roomOid = new Types.ObjectId(roomId);
    const senderOid = new Types.ObjectId(senderId);

    // Step 1: increment per-user contribution. Try $inc on existing
    // sub-doc first; if the user isn't in `contributions` yet, $push a
    // new entry. Two-step to avoid Mongo's "upsert with positional"
    // limitation.
    const inc = await this.stateModel
      .updateOne(
        {
          roomId: roomOid,
          dayKey,
          'contributions.userId': senderOid,
        },
        {
          $inc: {
            currentEnergy: energyDelta,
            'contributions.$.energy': energyDelta,
          },
        },
      )
      .exec();

    if (inc.modifiedCount === 0) {
      // Either the doc doesn't exist yet, or the user has no
      // contribution row yet. Use upsert + $push.
      // IMPORTANT: do NOT initialize `currentEnergy` in $setOnInsert —
      // it conflicts with the $inc on the same path and Mongo rejects
      // the whole op. $inc on a missing field starts from 0 anyway.
      try {
        await this.stateModel
          .updateOne(
            { roomId: roomOid, dayKey },
            {
              $setOnInsert: {
                roomId: roomOid,
                dayKey,
                currentLevel: 1,
                status: RocketStatus.IDLE,
                launches: [],
              },
              $inc: { currentEnergy: energyDelta },
              $push: {
                contributions: { userId: senderOid, energy: energyDelta },
              },
            },
            { upsert: true },
          )
          .exec();
      } catch (err: any) {
        this.log.error(
          `addEnergy upsert failed (room=${roomId}, sender=${senderId}): ${err?.message ?? err}`,
        );
        return;
      }
    }

    // Step 2: re-fetch to check threshold + flip to COUNTDOWN. We do
    // this after the increment so the value we read is post-write —
    // races between two senders are handled by the conditional flip
    // below (only ONE update succeeds).
    const fresh = await this.stateModel
      .findOne({ roomId: roomOid, dayKey })
      .exec();
    if (!fresh) return;

    // Self-heal a stranded level. If the room's saved `currentLevel` no
    // longer exists in the config — which happens when an admin removes
    // or renumbers levels AFTER this room had already climbed past them —
    // the room would otherwise be stuck forever: the launch check below
    // can't match a level, so it never launches and never loops, while
    // energy keeps piling up. Snap back to the lowest configured level so
    // the cycle resumes (the leftover energy carries straight into it).
    if (!config.levels.some((l) => l.level === fresh.currentLevel)) {
      const lowest = [...config.levels].sort((a, b) => a.level - b.level)[0];
      await this.stateModel
        .updateOne(
          { _id: fresh._id },
          { $set: { currentLevel: lowest.level } },
        )
        .exec();
      fresh.currentLevel = lowest.level;
      this.log.warn(
        `Rocket room ${roomId} was stranded on missing level — snapped to L${lowest.level}`,
      );
    }

    // Live fuel-update broadcast — fires on EVERY successful gift so
    // the in-room gauge animates in real time. Uses the post-increment
    // values so the client doesn't have to reconcile against a stale
    // snapshot.
    {
      const currentLv = config.levels.find(
        (l) => l.level === fresh.currentLevel,
      );
      if (currentLv) {
        void this.realtime.emitToRoom(
          roomId,
          RealtimeEventType.ROOM_ROCKET_FUEL,
          {
            roomId,
            level: fresh.currentLevel,
            currentEnergy: fresh.currentEnergy,
            energyRequired: currentLv.energyRequired,
            status: fresh.status,
          },
        );
      }
    }

    // Drive the phase machine. If a launch cycle is already running
    // (BANNER/COUNTDOWN), this nudges it forward whenever a phase is due —
    // so gifts keep the rocket moving even if the cron sweeper lags. If the
    // room is IDLE and this gift just filled the current level, it kicks off
    // a new cycle (resolve the launch queue → start the banner). Every
    // transition is status-guarded, so it's safe to run alongside the cron.
    try {
      await this.advanceRoom(fresh, config);
    } catch (err: any) {
      this.log.error(
        `advanceRoom failed (room=${roomId}): ${err?.message ?? err}`,
        err?.stack,
      );
    }
  }

  // ============================================================
  // Launch — fired by cron after the countdown elapses
  // ============================================================

  /**
   * Sweep all rooms whose countdown has elapsed and launch them.
   * Returns the count of launches for cron logging. Failures on
   * individual rooms are swallowed so one busted state doesn't stop
   * the rest of the sweep.
   */
  async sweepDueLaunches(now: Date = new Date()): Promise<number> {
    const config = await this.getConfig();
    if (!config.enabled || config.levels.length === 0) return 0;
    // Drive every room mid-cycle (BANNER or COUNTDOWN) to wherever `now` says
    // it should be. IDLE rooms are kicked off by the gift path; leftover fuel
    // is handled by the post-launch loop inside advanceRoom.
    const active = await this.stateModel
      .find({ status: { $in: [RocketStatus.BANNER, RocketStatus.COUNTDOWN] } })
      .exec();
    if (active.length > 0) {
      this.log.log(`rocket sweep: ${active.length} room(s) mid-cycle`);
    }
    let advanced = 0;
    for (const state of active) {
      const before = `${state.status}:${state.launchQueue.length}`;
      try {
        await this.advanceRoom(state, config, now);
        if (`${state.status}:${state.launchQueue.length}` !== before) {
          advanced += 1;
        }
      } catch (err: any) {
        this.log.error(
          `Rocket sweep failed for room ${state.roomId}: ${err?.message ?? err}`,
          err?.stack,
        );
      }
    }
    return advanced;
  }

  // ---- level helpers ----

  private sortedLevels(config: RocketConfigDocument): RocketLevel[] {
    return [...config.levels].sort((a, b) => a.level - b.level);
  }

  private levelThreshold(config: RocketConfigDocument, level: number): number {
    return (
      config.levels.find((l) => l.level === level)?.energyRequired ??
      Number.POSITIVE_INFINITY
    );
  }

  /** Next level number after `level`, wrapping to the first after the last. */
  private nextLevelNumber(config: RocketConfigDocument, level: number): number {
    const sorted = this.sortedLevels(config);
    const idx = sorted.findIndex((l) => l.level === level);
    if (idx < 0) return sorted[0].level;
    return idx >= sorted.length - 1 ? sorted[0].level : sorted[idx + 1].level;
  }

  /** Snap `currentLevel` to the lowest configured level if it's gone missing
   *  (admin removed/renumbered levels). Mutates `state` in memory only. */
  private ensureValidLevel(
    state: RocketRoomStateDocument,
    config: RocketConfigDocument,
  ): void {
    if (!config.levels.some((l) => l.level === state.currentLevel)) {
      state.currentLevel = this.sortedLevels(config)[0].level;
    }
  }

  // ============================================================
  // Phase machine — IDLE → BANNER → COUNTDOWN → launch → (next | IDLE)
  // ============================================================

  /**
   * Advance one room's phase machine to `now`, riding through every due
   * transition (e.g. countdown elapsed → launch → next rocket's banner).
   * Bounded so it can't spin. Safe to call from the gift path and the cron
   * at the same time — each transition is status-guarded, so only one wins.
   */
  async advanceRoom(
    state: RocketRoomStateDocument,
    config: RocketConfigDocument,
    now: Date = new Date(),
  ): Promise<void> {
    if (!config.enabled || config.levels.length === 0) return;
    for (let guard = 0; guard < 25; guard++) {
      const moved = await this.stepRoom(state, config, now);
      if (!moved) break;
    }
  }

  /** One phase transition. Returns true if it changed the room's state. */
  private async stepRoom(
    state: RocketRoomStateDocument,
    config: RocketConfigDocument,
    now: Date,
  ): Promise<boolean> {
    switch (state.status) {
      case RocketStatus.IDLE:
      case RocketStatus.COMPLETE: // legacy stuck state — treat as idle
        return this.tryStartCycle(state, config);
      case RocketStatus.BANNER: {
        const dueAt =
          (state.phaseStartedAt?.getTime() ?? 0) + config.bannerSeconds * 1000;
        if (now.getTime() < dueAt) return false;
        return this.startCountdown(state, config);
      }
      case RocketStatus.COUNTDOWN: {
        const dueAt =
          (state.phaseStartedAt?.getTime() ?? 0) +
          config.launchCountdownSeconds * 1000;
        if (now.getTime() < dueAt) return false;
        return this.fireLaunch(state, config);
      }
      default:
        return false;
    }
  }

  /**
   * IDLE → BANNER. If fuel has filled the current level, resolve every
   * currently-affordable level into the launch queue (consuming fuel and
   * advancing/looping `currentLevel`), then start the banner for the head.
   * Returns false if nothing is launchable yet.
   */
  private async tryStartCycle(
    state: RocketRoomStateDocument,
    config: RocketConfigDocument,
  ): Promise<boolean> {
    this.ensureValidLevel(state, config);

    const queue = [...state.launchQueue];
    let level = state.currentLevel;
    let energy = state.currentEnergy;
    // Pull as many whole levels as the fuel covers into the queue. Bounded so
    // a pathologically huge gift can't build a runaway queue.
    let added = 0;
    while (energy >= this.levelThreshold(config, level) && added < 50) {
      queue.push(level);
      energy -= this.levelThreshold(config, level);
      level = this.nextLevelNumber(config, level);
      added += 1;
    }
    if (queue.length === 0) return false; // still filling — nothing to launch

    const head = queue[0];
    const startedAt = new Date();
    const res = await this.stateModel
      .updateOne(
        {
          _id: state._id,
          status: { $in: [RocketStatus.IDLE, RocketStatus.COMPLETE] },
        },
        {
          $set: {
            status: RocketStatus.BANNER,
            launchQueue: queue,
            currentLevel: level,
            currentEnergy: energy,
            phaseStartedAt: startedAt,
            pendingLaunch: null,
          },
        },
      )
      .exec();
    if (res.modifiedCount === 0) return false; // lost the race to another caller

    state.status = RocketStatus.BANNER;
    state.launchQueue = queue;
    state.currentLevel = level;
    state.currentEnergy = energy;
    state.phaseStartedAt = startedAt;
    state.pendingLaunch = null;

    this.log.log(
      `Rocket room ${state.roomId.toString()}: banner for Lv.${head} ` +
        `(queue=[${queue.join(',')}], next-fill Lv.${level} @ ${energy})`,
    );
    await this.emitBanner(state, config, head);
    await this.emitFuel(state, config);
    return true;
  }

  /**
   * BANNER → COUNTDOWN. The gather window elapsed: snapshot the present
   * audience, compute this launch's winners from it (top-3 present + gate +
   * random present), persist them, and start the in-room countdown — sending
   * the Top-1's avatar so the countdown screen can show who's leading.
   */
  private async startCountdown(
    state: RocketRoomStateDocument,
    config: RocketConfigDocument,
  ): Promise<boolean> {
    const head = state.launchQueue[0];
    const lv = config.levels.find((l) => l.level === head);
    if (head == null || !lv) {
      // Head level vanished (admin edit mid-cycle) — drop it.
      return this.dropHeadAndContinue(state, config);
    }

    const seq = state.launchSeq;
    const { top, random } = await this.computeWinners(state, config, lv);
    const pending = { level: head, seq, top, random };
    const startedAt = new Date();

    const res = await this.stateModel
      .updateOne(
        { _id: state._id, status: RocketStatus.BANNER },
        {
          $set: {
            status: RocketStatus.COUNTDOWN,
            phaseStartedAt: startedAt,
            pendingLaunch: pending,
          },
        },
      )
      .exec();
    if (res.modifiedCount === 0) return false;

    state.status = RocketStatus.COUNTDOWN;
    state.phaseStartedAt = startedAt;
    state.pendingLaunch = pending as unknown as RocketRoomStateDocument['pendingLaunch'];

    await this.emitCountdown(state, config, lv, top);
    return true;
  }

  /**
   * COUNTDOWN → launch. Pay the snapshotted winners, append the launch
   * record, broadcast the launch animation + roster, then move to the next
   * queued rocket's banner (or back to IDLE — where leftover fuel may start a
   * fresh cycle on the next step).
   */
  private async fireLaunch(
    state: RocketRoomStateDocument,
    config: RocketConfigDocument,
  ): Promise<boolean> {
    const pending = state.pendingLaunch;
    if (!pending) {
      // No snapshot (shouldn't happen) — recover by dropping the head.
      return this.dropHeadAndContinue(state, config);
    }
    const lv = config.levels.find((l) => l.level === pending.level) ?? null;

    // 1. Pay winners. Idempotency keyed on the launch seq, so a retry never
    //    double-pays, but a later loop of the same level (new seq) does pay.
    for (const t of pending.top) {
      if (t.coinsAwarded <= 0) continue;
      try {
        await this.wallet.credit(Currency.COINS, {
          userId: t.userId.toString(),
          amount: t.coinsAwarded,
          type: TxnType.ROCKET_REWARD,
          description: `Rocket Top-${t.rank} (Lv.${pending.level})`,
          idempotencyKey: `rocket:top:${state._id.toString()}:${pending.seq}:${pending.level}:${t.userId.toString()}`,
          refType: 'rocket',
          refId: state._id.toString(),
        });
      } catch (err: any) {
        this.log.warn(
          `Top-${t.rank} credit failed for ${t.userId}: ${err?.message ?? err}`,
        );
      }
    }
    for (const r of pending.random) {
      if (r.coinsAwarded <= 0) continue;
      try {
        await this.wallet.credit(Currency.COINS, {
          userId: r.userId.toString(),
          amount: r.coinsAwarded,
          type: TxnType.ROCKET_REWARD,
          description: `Rocket random reward (Lv.${pending.level})`,
          idempotencyKey: `rocket:rand:${state._id.toString()}:${pending.seq}:${pending.level}:${r.userId.toString()}`,
          refType: 'rocket',
          refId: state._id.toString(),
        });
      } catch (err: any) {
        this.log.warn(
          `Random credit failed for ${r.userId}: ${err?.message ?? err}`,
        );
      }
    }

    // 2. Advance: pop the head, append history, bump seq. The next queued
    //    rocket (if any) goes straight to its BANNER; otherwise IDLE (where
    //    the advance loop may immediately start a fresh cycle off leftover).
    const queue = state.launchQueue.slice(1);
    const launchedAt = new Date();
    const record = {
      level: pending.level,
      launchedAt,
      topContributors: pending.top,
      randomBeneficiaries: pending.random,
    };
    const nextStatus =
      queue.length > 0 ? RocketStatus.BANNER : RocketStatus.IDLE;
    const startedAt = queue.length > 0 ? launchedAt : null;
    const newSeq = state.launchSeq + 1;

    const res = await this.stateModel
      .updateOne(
        { _id: state._id, status: RocketStatus.COUNTDOWN },
        {
          $set: {
            status: nextStatus,
            launchQueue: queue,
            phaseStartedAt: startedAt,
            pendingLaunch: null,
            launchSeq: newSeq,
          },
          $push: { launches: record },
        },
      )
      .exec();
    if (res.modifiedCount === 0) return false;

    state.status = nextStatus;
    state.launchQueue = queue;
    state.phaseStartedAt = startedAt;
    state.pendingLaunch = null;
    state.launchSeq = newSeq;
    state.launches.push(
      record as unknown as RocketRoomStateDocument['launches'][number],
    );

    this.log.log(
      `Rocket room ${state.roomId.toString()}: LAUNCHED Lv.${pending.level} ` +
        `(seq=${pending.seq}, remaining queue=[${queue.join(',')}])`,
    );

    await this.emitLaunched(state, config, lv, pending, queue);
    if (queue.length > 0) await this.emitBanner(state, config, queue[0]);
    await this.emitFuel(state, config);
    return true;
  }

  /** Drop a head level that no longer exists in the config; re-banner the
   *  next queued level or fall back to IDLE. */
  private async dropHeadAndContinue(
    state: RocketRoomStateDocument,
    config: RocketConfigDocument,
  ): Promise<boolean> {
    const queue = state.launchQueue.slice(1);
    const nextStatus =
      queue.length > 0 ? RocketStatus.BANNER : RocketStatus.IDLE;
    const startedAt = queue.length > 0 ? new Date() : null;
    await this.stateModel
      .updateOne(
        {
          _id: state._id,
          status: { $in: [RocketStatus.BANNER, RocketStatus.COUNTDOWN] },
        },
        {
          $set: {
            status: nextStatus,
            launchQueue: queue,
            phaseStartedAt: startedAt,
            pendingLaunch: null,
          },
        },
      )
      .exec();
    state.status = nextStatus;
    state.launchQueue = queue;
    state.phaseStartedAt = startedAt;
    state.pendingLaunch = null;
    if (queue.length > 0) await this.emitBanner(state, config, queue[0]);
    return true;
  }

  /**
   * Snapshot the present audience and compute this launch's winners:
   *   • Top-1/2/3 among PRESENT contributors that clear the gate.
   *   • Random pool split among PRESENT non-top members.
   * "Present" = a RoomMember row with a recent heartbeat (rows are removed on
   * leave, so this is the live audience the banner gathered).
   */
  private async computeWinners(
    state: RocketRoomStateDocument,
    config: RocketConfigDocument,
    lv: RocketLevel,
  ): Promise<{
    top: Array<{
      userId: Types.ObjectId;
      rank: number;
      energy: number;
      coinsAwarded: number;
    }>;
    random: Array<{ userId: Types.ObjectId; coinsAwarded: number }>;
  }> {
    const presentCutoff = new Date(Date.now() - PRESENCE_WINDOW_MS);
    const members = await this.memberModel
      .find({ roomId: state.roomId, lastSeenAt: { $gte: presentCutoff } })
      .select({ userId: 1 })
      .exec();
    const presentIds = new Set(
      members
        .map((m) => m.userId?.toString())
        .filter((id): id is string => !!id),
    );

    // Top-3: present contributors, ranked by contributed energy, gated.
    const ranked = [...state.contributions]
      .filter((c) => presentIds.has(c.userId.toString()))
      .sort((a, b) => b.energy - a.energy);
    const fixed = [lv.top1Coins, lv.top2Coins, lv.top3Coins];
    const top: Array<{
      userId: Types.ObjectId;
      rank: number;
      energy: number;
      coinsAwarded: number;
    }> = [];
    for (let i = 0; i < Math.min(3, ranked.length); i++) {
      if (ranked[i].energy < config.topContributionThreshold) break; // gate
      top.push({
        userId: ranked[i].userId,
        rank: i + 1,
        energy: ranked[i].energy,
        coinsAwarded: fixed[i],
      });
    }

    // Random: present members excluding the top-3.
    const topIds = new Set(top.map((t) => t.userId.toString()));
    const pool = [...presentIds]
      .filter((id) => !topIds.has(id))
      .map((id) => new Types.ObjectId(id));
    const pickCount = Math.min(lv.randomBeneficiaries, pool.length);
    for (let i = pool.length - 1; i > 0 && i >= pool.length - pickCount; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const picked = pool.slice(pool.length - pickCount);
    const random: Array<{ userId: Types.ObjectId; coinsAwarded: number }> = [];
    if (picked.length > 0) {
      const each = Math.floor(lv.randomPoolCoins / picked.length);
      const leftover = lv.randomPoolCoins - each * picked.length;
      picked.forEach((id, i) =>
        random.push({
          userId: id,
          coinsAwarded: each + (i === 0 ? leftover : 0),
        }),
      );
    }
    return { top, random };
  }

  // ---- broadcasts ----

  private async emitBanner(
    state: RocketRoomStateDocument,
    config: RocketConfigDocument,
    level: number,
  ): Promise<void> {
    const room = await this.roomModel
      .findById(state.roomId)
      .select({ name: 1, numericId: 1 })
      .exec()
      .catch(() => null);
    const lv = config.levels.find((l) => l.level === level);
    void this.realtime.emitGlobal(RealtimeEventType.GLOBAL_ROCKET_BANNER, {
      roomId: state.roomId.toString(),
      roomName: room?.name ?? '',
      level,
      // Distinct per launch so the app de-dupes per launch, not per level
      // (the same level loops many times a day).
      seq: state.launchSeq,
      iconUrl: lv?.iconUrl ?? '',
      assetUrl: lv?.assetUrl ?? '',
      // Time from now until the animation: banner gather + countdown.
      countdownSeconds: config.bannerSeconds + config.launchCountdownSeconds,
      triggeredById: '',
      triggeredByName: '',
      triggeredByAvatarUrl: '',
    });
    // Room-scoped heads-up so clients ALREADY in the room start downloading
    // the launch video during the banner window (no overlay yet) — by the
    // time the countdown ends the video is on-device for smooth playback.
    void this.realtime.emitToRoom(
      state.roomId.toString(),
      RealtimeEventType.ROOM_ROCKET_LAUNCH,
      {
        roomId: state.roomId.toString(),
        level,
        stage: 'banner',
        assetUrl: lv?.assetUrl ?? '',
        iconUrl: lv?.iconUrl ?? '',
      },
    );
  }

  private async emitCountdown(
    state: RocketRoomStateDocument,
    config: RocketConfigDocument,
    lv: RocketLevel,
    top: Array<{
      userId: Types.ObjectId;
      rank: number;
      energy: number;
      coinsAwarded: number;
    }>,
  ): Promise<void> {
    const top1 = top.length > 0 ? await this.hydrateUser(top[0].userId) : null;
    void this.realtime.emitToRoom(
      state.roomId.toString(),
      RealtimeEventType.ROOM_ROCKET_LAUNCH,
      {
        roomId: state.roomId.toString(),
        level: lv.level,
        stage: 'countdown',
        assetUrl: lv.assetUrl,
        iconUrl: lv.iconUrl,
        countdownSeconds: config.launchCountdownSeconds,
        // Leading contributor (from the present audience) — shown on the
        // countdown screen so the crowd sees who's winning.
        top1,
      },
    );
  }

  private async emitLaunched(
    state: RocketRoomStateDocument,
    config: RocketConfigDocument,
    lv: RocketLevel | null,
    pending: {
      level: number;
      top: Array<{
        userId: Types.ObjectId;
        rank: number;
        energy: number;
        coinsAwarded: number;
      }>;
      random: Array<{ userId: Types.ObjectId; coinsAwarded: number }>;
    },
    queue: number[],
  ): Promise<void> {
    const ids = [
      ...pending.top.map((t) => t.userId),
      ...pending.random.map((r) => r.userId),
    ];
    const users = ids.length
      ? await this.userModel
          .find({ _id: { $in: ids } })
          .select({ username: 1, displayName: 1, avatarUrl: 1, numericId: 1 })
          .lean()
          .exec()
      : [];
    const map = new Map<string, (typeof users)[number]>();
    for (const u of users) map.set(u._id.toString(), u);
    const hydrate = (userId: Types.ObjectId) => {
      const u = map.get(userId.toString());
      return u
        ? {
            id: u._id.toString(),
            username: u.username ?? '',
            displayName: u.displayName ?? '',
            avatarUrl: u.avatarUrl ?? '',
            numericId: u.numericId ?? null,
          }
        : null;
    };
    const sorted = this.sortedLevels(config);
    const maxLevel = sorted.length
      ? sorted[sorted.length - 1].level
      : pending.level;
    void this.realtime.emitToRoom(
      state.roomId.toString(),
      RealtimeEventType.ROOM_ROCKET_LAUNCH,
      {
        roomId: state.roomId.toString(),
        level: pending.level,
        stage: 'launched',
        assetUrl: lv?.assetUrl ?? '',
        iconUrl: lv?.iconUrl ?? '',
        topContributors: pending.top.map((t) => ({
          userId: t.userId.toString(),
          user: hydrate(t.userId),
          rank: t.rank,
          energy: t.energy,
          coinsAwarded: t.coinsAwarded,
        })),
        randomBeneficiaries: pending.random.map((r) => ({
          userId: r.userId.toString(),
          user: hydrate(r.userId),
          coinsAwarded: r.coinsAwarded,
        })),
        // The level the gauge fills next, and how many more rockets wait.
        nextLevel: state.currentLevel,
        queued: queue.length,
        wrapped: pending.level === maxLevel,
      },
    );
  }

  private async emitFuel(
    state: RocketRoomStateDocument,
    config: RocketConfigDocument,
  ): Promise<void> {
    const lv = config.levels.find((l) => l.level === state.currentLevel);
    if (!lv) return;
    void this.realtime.emitToRoom(
      state.roomId.toString(),
      RealtimeEventType.ROOM_ROCKET_FUEL,
      {
        roomId: state.roomId.toString(),
        level: state.currentLevel,
        currentEnergy: state.currentEnergy,
        energyRequired: lv.energyRequired,
        status: state.status,
      },
    );
  }

  private async hydrateUser(userId: Types.ObjectId): Promise<{
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string;
    numericId: number | null;
  } | null> {
    const u = await this.userModel
      .findById(userId)
      .select({ username: 1, displayName: 1, avatarUrl: 1, numericId: 1 })
      .lean()
      .exec()
      .catch(() => null);
    if (!u) return null;
    return {
      id: u._id.toString(),
      username: u.username ?? '',
      displayName: u.displayName ?? '',
      avatarUrl: u.avatarUrl ?? '',
      numericId: u.numericId ?? null,
    };
  }

  // ============================================================
  // Daily reset — cron at 00:00 Asia/Dhaka
  // ============================================================

  /**
   * Bookkeeping is implicit — every gift's `addEnergy` upserts on the
   * NEW dayKey, so yesterday's row is left untouched as historical
   * data. This method exists for explicit cleanup if ever needed (e.g.
   * stale countdowns from before a server crash).
   */
  async dailyReset(): Promise<number> {
    // Force any rooms still mid-cycle from a previous day all the way to
    // completion, so snapshotted rewards aren't held hostage by a crash.
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const stale = await this.stateModel
      .find({
        status: { $in: [RocketStatus.BANNER, RocketStatus.COUNTDOWN] },
        phaseStartedAt: { $lt: yesterday, $ne: null },
      })
      .exec();
    const config = await this.getConfig();
    // A far-future "now" makes every pending phase due, so the whole queue
    // drains in a single advanceRoom pass.
    const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    let recovered = 0;
    for (const s of stale) {
      try {
        await this.advanceRoom(s, config, farFuture);
        recovered += 1;
      } catch (err: any) {
        this.log.error(
          `Stale rocket recovery failed for ${s._id}: ${err?.message ?? err}`,
        );
      }
    }
    return recovered;
  }

  // ============================================================
  // Helpers
  // ============================================================

  getDayKey(now: Date): string {
    const local = new Date(now.getTime() + TZ_OFFSET_MS);
    const y = local.getUTCFullYear();
    const m = (local.getUTCMonth() + 1).toString().padStart(2, '0');
    const d = local.getUTCDate().toString().padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  /** Next 00:00 in the configured timezone — used by the mobile UI to
   *  render the "Reset countdown" timer. */
  async nextResetAt(now: Date = new Date()): Promise<Date> {
    const local = new Date(now.getTime() + TZ_OFFSET_MS);
    // Move to the next local midnight.
    const localMidnight = new Date(local);
    localMidnight.setUTCHours(0, 0, 0, 0);
    localMidnight.setUTCDate(local.getUTCDate() + 1);
    return new Date(localMidnight.getTime() - TZ_OFFSET_MS);
  }

  /** Used by getStateOrThrow when an admin / test endpoint demands a
   *  hard 404 vs the auto-create path mobile uses. */
  async getStateOrThrow(roomId: string): Promise<RocketRoomStateDocument> {
    const s = await this.getState(roomId);
    if (!s) throw new NotFoundException({ code: 'ROCKET_NOT_FOUND', message: 'Rocket state not found' });
    return s;
  }
}
