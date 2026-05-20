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
            launchCountdownSeconds: 20,
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

    // A launch is ALREADY mid-countdown. Normally the cron sweeper fires
    // it once the countdown elapses, and we leave it alone here. BUT if
    // the countdown is already OVERDUE — the sweeper missed a tick, isn't
    // running in this environment, or the countdown ended between ticks —
    // launch it inline from the gift path. This guarantees a gift always
    // *does something* and the rocket can never wedge in COUNTDOWN
    // forever. launchOne's atomic `status: COUNTDOWN` filter means a race
    // with the cron can't double-launch (only one update wins).
    if (fresh.status === RocketStatus.COUNTDOWN) {
      const dueAtMs =
        (fresh.countdownStartedAt?.getTime() ?? Date.now()) +
        config.launchCountdownSeconds * 1000;
      if (Date.now() >= dueAtMs) {
        try {
          await this.launchOne(fresh, config);
        } catch (err: any) {
          this.log.error(
            `Inline overdue launch failed (room=${roomId}): ${err?.message ?? err}`,
          );
        }
      }
      return;
    }

    const lv = config.levels.find((l) => l.level === fresh.currentLevel);
    if (!lv) return; // out of levels — admin removed all levels

    if (fresh.currentEnergy < lv.energyRequired) return; // still filling

    // Atomic flip — ensures only one concurrent caller wins the launch.
    // Accepts both IDLE and the legacy COMPLETE so stuck rows return
    // to the cycle on the next gift instead of waiting for the day
    // boundary.
    const flip = await this.stateModel
      .updateOne(
        {
          _id: fresh._id,
          status: { $in: [RocketStatus.IDLE, RocketStatus.COMPLETE] },
        },
        {
          $set: {
            status: RocketStatus.COUNTDOWN,
            countdownStartedAt: new Date(),
          },
        },
      )
      .exec();
    if (flip.modifiedCount === 0) return;

    // Broadcast — room listeners render the launch countdown overlay.
    void this.realtime.emitToRoom(roomId, RealtimeEventType.ROOM_ROCKET_LAUNCH, {
      roomId,
      level: fresh.currentLevel,
      countdownSeconds: config.launchCountdownSeconds,
      stage: 'countdown',
      assetUrl: lv.assetUrl,
      iconUrl: lv.iconUrl,
    });
    // Also a global banner so users in other rooms see the rocket
    // about to launch and can hop in.
    const [room, sender] = await Promise.all([
      this.roomModel
        .findById(roomOid)
        .select({ name: 1, numericId: 1 })
        .exec(),
      this.userModel
        .findById(senderOid)
        .select({ displayName: 1, username: 1, avatarUrl: 1 })
        .exec(),
    ]);
    void this.realtime.emitGlobal(
      RealtimeEventType.GLOBAL_ROCKET_BANNER,
      {
        roomId,
        roomName: room?.name ?? '',
        level: fresh.currentLevel,
        triggeredById: senderId,
        triggeredByName: sender?.displayName?.trim().length
          ? sender!.displayName
          : (sender?.username ?? 'Someone'),
        triggeredByAvatarUrl: sender?.avatarUrl ?? '',
        countdownSeconds: config.launchCountdownSeconds,
      },
    );
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
    const cutoff = new Date(
      now.getTime() - config.launchCountdownSeconds * 1000,
    );
    const due = await this.stateModel
      .find({
        status: RocketStatus.COUNTDOWN,
        countdownStartedAt: { $lte: cutoff, $ne: null },
      })
      .exec();
    let launched = 0;
    for (const state of due) {
      try {
        await this.launchOne(state, config);
        launched += 1;
      } catch (err: any) {
        this.log.error(
          `Launch failed for room ${state.roomId}: ${err?.message ?? err}`,
        );
      }
    }
    return launched;
  }

  /** Run a single launch — distribute rewards, advance the level. */
  private async launchOne(
    state: RocketRoomStateDocument,
    config: RocketConfigDocument,
  ): Promise<void> {
    let lv = config.levels.find((l) => l.level === state.currentLevel);
    if (!lv) {
      // The saved level vanished from the config (admin edit) between the
      // countdown flip and this sweep. Snap to the lowest configured level
      // and launch that instead of dead-ending, so the room keeps cycling.
      const lowest = config.levels.length
        ? [...config.levels].sort((a, b) => a.level - b.level)[0]
        : null;
      if (!lowest) {
        // No levels at all — nothing to launch. Park it.
        await this.stateModel
          .updateOne(
            { _id: state._id, status: RocketStatus.COUNTDOWN },
            { $set: { status: RocketStatus.COMPLETE } },
          )
          .exec();
        return;
      }
      state.currentLevel = lowest.level;
      lv = lowest;
    }

    // 1. Resolve top-3 contributors (only those above threshold).
    const sorted = [...state.contributions].sort(
      (a, b) => b.energy - a.energy,
    );
    const top: Array<{
      userId: Types.ObjectId;
      rank: number;
      energy: number;
      coinsAwarded: number;
    }> = [];
    const fixedCoinPerRank = [lv.top1Coins, lv.top2Coins, lv.top3Coins];
    for (let i = 0; i < Math.min(3, sorted.length); i++) {
      const entry = sorted[i];
      if (entry.energy < config.topContributionThreshold) break;
      top.push({
        userId: entry.userId,
        rank: i + 1,
        energy: entry.energy,
        coinsAwarded: fixedCoinPerRank[i],
      });
    }

    // 2. Pick random beneficiaries from active room members EXCLUDING
    //    the top-3 (they already won fixed). Active = recent
    //    RoomMember.lastSeenAt within the last hour.
    const topIds = new Set(top.map((t) => t.userId.toString()));
    const recentMembers = await this.memberModel
      .find({
        roomId: state.roomId,
        lastSeenAt: { $gte: new Date(Date.now() - 60 * 60 * 1000) },
      })
      .select({ userId: 1 })
      .exec();
    const candidatePool = recentMembers
      .map((m) => m.userId)
      .filter((id): id is Types.ObjectId => id != null && !topIds.has(id.toString()));

    const pickCount = Math.min(lv.randomBeneficiaries, candidatePool.length);
    const picked: Types.ObjectId[] = [];
    if (pickCount > 0) {
      // Fisher-Yates partial — shuffle the candidate pool, take first N.
      const arr = [...candidatePool];
      for (let i = arr.length - 1; i > 0 && i >= arr.length - pickCount; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      picked.push(...arr.slice(arr.length - pickCount));
    }
    // Split the pool evenly among picked users; rounding leftover goes
    // to user 0 (same pattern as Lucky Bag's tier distribution).
    const randomBeneficiaries: Array<{
      userId: Types.ObjectId;
      coinsAwarded: number;
    }> = [];
    if (picked.length > 0) {
      const each = Math.floor(lv.randomPoolCoins / picked.length);
      const leftover = lv.randomPoolCoins - each * picked.length;
      for (let i = 0; i < picked.length; i++) {
        randomBeneficiaries.push({
          userId: picked[i],
          coinsAwarded: each + (i === 0 ? leftover : 0),
        });
      }
    }

    // 3. Credit wallets. Idempotency keys are deterministic per
    //    (state, launchSeq, level, userId) so a retry of the same launch
    //    never double-credits, BUT a wrap-around launch of the same
    //    level later in the day uses a distinct seq and thus distinct
    //    idempotency keys — so the user gets their fresh reward.
    const launchSeq = state.launches.length;
    for (const t of top) {
      if (t.coinsAwarded <= 0) continue;
      try {
        await this.wallet.credit(Currency.COINS, {
          userId: t.userId.toString(),
          amount: t.coinsAwarded,
          type: TxnType.ROCKET_REWARD,
          description: `Rocket Top-${t.rank} (Lv.${lv.level})`,
          idempotencyKey: `rocket:top:${state._id.toString()}:${launchSeq}:${lv.level}:${t.userId.toString()}`,
          refType: 'rocket',
          refId: state._id.toString(),
        });
      } catch (err: any) {
        this.log.warn(
          `Top-${t.rank} credit failed for ${t.userId}: ${err?.message ?? err}`,
        );
      }
    }
    for (const r of randomBeneficiaries) {
      if (r.coinsAwarded <= 0) continue;
      try {
        await this.wallet.credit(Currency.COINS, {
          userId: r.userId.toString(),
          amount: r.coinsAwarded,
          type: TxnType.ROCKET_REWARD,
          description: `Rocket random reward (Lv.${lv.level})`,
          idempotencyKey: `rocket:rand:${state._id.toString()}:${launchSeq}:${lv.level}:${r.userId.toString()}`,
          refType: 'rocket',
          refId: state._id.toString(),
        });
      } catch (err: any) {
        this.log.warn(
          `Random credit failed for ${r.userId}: ${err?.message ?? err}`,
        );
      }
    }

    // 4. Advance state — append the launch record, carry the residual
    //    energy over to the next level. When the last level launches we
    //    WRAP AROUND to L1 so the rocket keeps cycling all day; a huge
    //    single gift can ride past the top of the ladder and start a
    //    fresh round, bringing whatever's left over with it.
    const launchedAt = new Date();
    const sortedLevels = [...config.levels].sort((a, b) => a.level - b.level);
    const currentIdx = sortedLevels.findIndex((l) => l.level === lv.level);
    const isLastLevel = currentIdx >= sortedLevels.length - 1;
    const residualEnergy = Math.max(0, state.currentEnergy - lv.energyRequired);
    // Sequential next level, or wrap to the first level if we just
    // launched the last one. `nextLv` is non-null whenever there's at
    // least one configured level (which we already verified above).
    const nextLv = isLastLevel
      ? sortedLevels[0]
      : sortedLevels[currentIdx + 1];

    const launchRecord = {
      level: lv.level,
      launchedAt,
      topContributors: top,
      randomBeneficiaries,
    };

    // Decide whether to immediately queue the NEXT level for cascade
    // launch. The cascade fires `cascadeDelaySeconds` after THIS launch
    // (config-tunable, default 30s). Wrap-around launches qualify too —
    // a 1M coin gift on a 100K+300K+500K ladder will fire L1, L2, L3,
    // then cascade L1 again with the leftover 100K.
    let cascadeQueued = false;
    let cascadeCountdownStartedAt: Date | null = null;
    let cascadeNextLevel: number | null = null;
    if (nextLv && residualEnergy >= nextLv.energyRequired) {
      // The sweeper fires when
      //   countdownStartedAt + launchCountdownSeconds <= now,
      // so we set it back-dated such that the *due* time lands exactly
      // `cascadeDelaySeconds` after THIS launch finished.
      const cascadeDueAt = new Date(
        launchedAt.getTime() + config.cascadeDelaySeconds * 1000,
      );
      cascadeCountdownStartedAt = new Date(
        cascadeDueAt.getTime() - config.launchCountdownSeconds * 1000,
      );
      cascadeQueued = true;
      cascadeNextLevel = nextLv.level;
    }

    await this.stateModel
      .updateOne(
        { _id: state._id, status: RocketStatus.COUNTDOWN },
        {
          $set: {
            status: cascadeQueued
              ? RocketStatus.COUNTDOWN
              : RocketStatus.IDLE,
            currentLevel: nextLv.level,
            currentEnergy: residualEnergy,
            countdownStartedAt: cascadeQueued
              ? cascadeCountdownStartedAt
              : null,
          },
          $push: { launches: launchRecord },
        },
      )
      .exec();

    const roomIdStr = state.roomId.toString();

    // 5. Broadcast — room renders the explosion + reward roster, global
    //    banner shows winners. Hydrate the winners' user docs so the
    //    mobile launch overlay can render names + avatars without
    //    falling back to "User <last-4-of-id>".
    const winnerIds = [
      ...top.map((t) => t.userId),
      ...randomBeneficiaries.map((r) => r.userId),
    ];
    const winnerUsers = winnerIds.length
      ? await this.userModel
          .find({ _id: { $in: winnerIds } })
          .select({ username: 1, displayName: 1, avatarUrl: 1, numericId: 1 })
          .lean()
          .exec()
      : [];
    const userMap = new Map<string, (typeof winnerUsers)[number]>();
    for (const u of winnerUsers) {
      userMap.set(u._id.toString(), u);
    }
    const hydrate = (userId: Types.ObjectId) => {
      const u = userMap.get(userId.toString());
      if (!u) return null;
      return {
        id: u._id.toString(),
        username: u.username ?? '',
        displayName: u.displayName ?? '',
        avatarUrl: u.avatarUrl ?? '',
        numericId: u.numericId ?? null,
      };
    };
    void this.realtime.emitToRoom(
      roomIdStr,
      RealtimeEventType.ROOM_ROCKET_LAUNCH,
      {
        roomId: roomIdStr,
        level: lv.level,
        stage: 'launched',
        // Launch animation + thumbnail for THIS level so the room can
        // play the rocket overlay (SVGA / image). Admin sets these per
        // level in the rocket config.
        assetUrl: lv.assetUrl,
        iconUrl: lv.iconUrl,
        topContributors: top.map((t) => ({
          userId: t.userId.toString(),
          user: hydrate(t.userId),
          rank: t.rank,
          energy: t.energy,
          coinsAwarded: t.coinsAwarded,
        })),
        randomBeneficiaries: randomBeneficiaries.map((r) => ({
          userId: r.userId.toString(),
          user: hydrate(r.userId),
          coinsAwarded: r.coinsAwarded,
        })),
        nextLevel: nextLv.level,
        wrapped: isLastLevel,
      },
    );

    // Live fuel update for the new level — gauge resets to the residual.
    void this.realtime.emitToRoom(
      roomIdStr,
      RealtimeEventType.ROOM_ROCKET_FUEL,
      {
        roomId: roomIdStr,
        level: nextLv.level,
        currentEnergy: residualEnergy,
        energyRequired: nextLv.energyRequired,
        status: cascadeQueued
          ? RocketStatus.COUNTDOWN
          : RocketStatus.IDLE,
      },
    );

    // Cascade banner — countdown event so the mobile flips its overlay
    // to "Launching Lv.N+1 in X..." with the correct wait time.
    if (cascadeQueued && cascadeNextLevel != null) {
      const cascadeWaitSeconds = Math.max(
        config.launchCountdownSeconds,
        config.cascadeDelaySeconds,
      );
      void this.realtime.emitToRoom(
        roomIdStr,
        RealtimeEventType.ROOM_ROCKET_LAUNCH,
        {
          roomId: roomIdStr,
          level: cascadeNextLevel,
          countdownSeconds: config.cascadeDelaySeconds,
          waitSeconds: cascadeWaitSeconds,
          stage: 'countdown',
          cascade: true,
          // Next level's art so the room countdown can show the right
          // rocket icon instead of the glyph fallback.
          assetUrl: nextLv.assetUrl,
          iconUrl: nextLv.iconUrl,
        },
      );
      // Global cascade banner — same treatment as the first launch so
      // anyone in another room sees the next rocket coming.
      const room = await this.roomModel
        .findById(state.roomId)
        .select({ name: 1, numericId: 1 })
        .exec()
        .catch(() => null);
      void this.realtime.emitGlobal(
        RealtimeEventType.GLOBAL_ROCKET_BANNER,
        {
          roomId: roomIdStr,
          roomName: room?.name ?? '',
          level: cascadeNextLevel,
          triggeredById: '',
          triggeredByName: 'Cascade',
          triggeredByAvatarUrl: '',
          countdownSeconds: config.cascadeDelaySeconds,
          cascade: true,
        },
      );
    }
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
    // Find any stale COUNTDOWN rows from older days and force-launch
    // them so rewards aren't permanently held hostage by a crash.
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const stale = await this.stateModel
      .find({
        status: RocketStatus.COUNTDOWN,
        countdownStartedAt: { $lt: yesterday, $ne: null },
      })
      .exec();
    const config = await this.getConfig();
    let recovered = 0;
    for (const s of stale) {
      try {
        await this.launchOne(s, config);
        recovered += 1;
      } catch (err: any) {
        this.log.error(
          `Stale launch recovery failed for ${s._id}: ${err?.message ?? err}`,
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
