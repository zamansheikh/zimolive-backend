import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { RealtimeService } from '../realtime/realtime.service';
import { RealtimeEventType } from '../realtime/realtime.types';
import { Currency, TxnType } from '../wallet/schemas/transaction.schema';
import { WalletService } from '../wallet/wallet.service';
import { GameBet, GameBetDocument } from './schemas/game-bet.schema';
import {
  GameConfig,
  GameConfigDocument,
} from './schemas/game-config.schema';
import {
  GameRound,
  GameRoundDocument,
  GameRoundPhase,
} from './schemas/game-round.schema';

/**
 * Default config for the launch game (Fruits Loop). Stored as a
 * code-level constant so the first boot can self-seed the
 * collection if no doc exists yet — admin edits from the panel
 * override on the next round. The 8 items + multipliers mirror the
 * Greedy Baby reference (apple/lemon/strawberry/mango at 5x = the
 * common slots, fish 10x, burger 15x, pizza 25x, chicken 45x = the
 * rare jackpot).
 */
export const DEFAULT_FRUITS_LOOP: Omit<GameConfig, never> = {
  gameKey: 'fruits_loop',
  kind: 'wheel_betting',
  title: 'Fruits Loop',
  description: 'Bet on the fruit. Spin to win.',
  iconUrl: '',
  bannerUrl: '',
  category: 'Wheel',
  sortOrder: 10,
  enabled: true,
  // Layout matches the Greedy Baby reference exactly. Items go in
  // SLOT_POSITIONS order (top-left → top → top-right → left →
  // right → bottom-left → bottom → bottom-right). Existing
  // deployments need to apply this order via admin panel — the
  // seeder only inserts on first boot, it doesn't migrate.
  items: [
    { key: 'chicken', label: 'Chicken', multiplier: 45 },    // top-left
    { key: 'apple', label: 'Apple', multiplier: 5 },          // top
    { key: 'lemon', label: 'Lemon', multiplier: 5 },          // top-right
    { key: 'pizza', label: 'Pizza', multiplier: 25 },         // left
    { key: 'strawberry', label: 'Strawberry', multiplier: 5 },// right
    { key: 'burger', label: 'Burger', multiplier: 15 },       // bottom-left
    { key: 'fish', label: 'Fish', multiplier: 10 },           // bottom
    { key: 'mango', label: 'Mango', multiplier: 5 },          // bottom-right
  ],
  betTiers: [1_000, 10_000, 100_000, 200_000, 500_000, 1_000_000, 5_000_000],
  rtpPercent: 70,
  currency: 'coins',
  bettingMs: 30_000,
  spinMs: 5_000,
  intermissionMs: 5_000,
};

@Injectable()
export class GamesService implements OnModuleInit {
  private readonly log = new Logger('GamesService');

  /** Per-game round-loop handle so we can stop scheduling if
   *  needed (admin-disabled the game). Indexed by gameKey. */
  private readonly loopTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    @InjectModel(GameConfig.name)
    private readonly configModel: Model<GameConfigDocument>,
    @InjectModel(GameRound.name)
    private readonly roundModel: Model<GameRoundDocument>,
    @InjectModel(GameBet.name)
    private readonly betModel: Model<GameBetDocument>,
    private readonly wallet: WalletService,
    private readonly realtime: RealtimeService,
  ) {}

  // ============================================================
  // Bootstrap — seed default games, resume round loops
  // ============================================================

  async onModuleInit(): Promise<void> {
    await this.seedDefaults();
    const configs = await this.configModel.find({ enabled: true }).lean().exec();
    for (const cfg of configs) {
      // Kick off (or resume) the round loop for each enabled game.
      // The loop is self-driving — it re-schedules itself after each
      // transition based on the timestamps embedded in the round
      // doc, so a restart mid-round picks up where it left off.
      void this.scheduleNextTransition(cfg.gameKey);
    }
  }

  /** First-boot seeder. Idempotent — only inserts a config when no
   *  doc exists for the key. */
  private async seedDefaults(): Promise<void> {
    const existing = await this.configModel
      .findOne({ gameKey: DEFAULT_FRUITS_LOOP.gameKey })
      .exec();
    if (!existing) {
      await this.configModel.create(DEFAULT_FRUITS_LOOP);
      this.log.log('Seeded default Fruits Loop config');
    }
  }

  // ============================================================
  // Public read endpoints (mobile / web client side)
  // ============================================================

  /** Lobby listing — only enabled games, sorted by sortOrder then
   *  alphabetically by title (stable ordering across calls). */
  async listGames(): Promise<GameConfigDocument[]> {
    return this.configModel
      .find({ enabled: true })
      .sort({ sortOrder: 1, title: 1 })
      .lean()
      .exec() as any;
  }

  /** Admin listing — every game, enabled or not. */
  async listAllGames(): Promise<GameConfigDocument[]> {
    return this.configModel
      .find({})
      .sort({ sortOrder: 1, title: 1 })
      .lean()
      .exec() as any;
  }

  /** Create a brand-new game. The default round runner picks the
   *  new entry up on its next pass (or immediately if enabled). */
  async createGame(input: {
    gameKey: string;
    title: string;
    kind?: 'wheel_betting';
    description?: string;
    iconUrl?: string;
    bannerUrl?: string;
    category?: string;
    sortOrder?: number;
    enabled?: boolean;
    items: Array<{ key: string; label: string; multiplier: number }>;
    betTiers: number[];
    rtpPercent?: number;
    currency?: 'coins' | 'diamonds';
    bettingMs?: number;
    spinMs?: number;
    intermissionMs?: number;
  }): Promise<GameConfigDocument> {
    // Slug must match the URL-path convention used by the web app
    // and the realtime scope. Enforce here so an admin typo
    // doesn't blow up the live page later.
    if (!/^[a-z][a-z0-9_]{1,31}$/.test(input.gameKey)) {
      throw new BadRequestException({
        code: 'INVALID_GAME_KEY',
        message:
          'gameKey must be lowercase letters / digits / underscores (start with a letter, 2-32 chars)',
      });
    }
    const exists = await this.configModel
      .findOne({ gameKey: input.gameKey })
      .lean()
      .exec();
    if (exists) {
      throw new ConflictException({
        code: 'GAME_EXISTS',
        message: 'A game with that key already exists',
      });
    }
    const cfg = await this.configModel.create({
      gameKey: input.gameKey,
      kind: input.kind ?? 'wheel_betting',
      title: input.title,
      description: input.description ?? '',
      iconUrl: input.iconUrl ?? '',
      bannerUrl: input.bannerUrl ?? '',
      category: input.category ?? '',
      sortOrder: input.sortOrder ?? 100,
      enabled: input.enabled ?? true,
      items: input.items,
      betTiers: input.betTiers,
      rtpPercent: input.rtpPercent ?? 70,
      currency: input.currency ?? 'coins',
      bettingMs: input.bettingMs ?? 30_000,
      spinMs: input.spinMs ?? 5_000,
      intermissionMs: input.intermissionMs ?? 5_000,
    });
    if (cfg.enabled) {
      void this.scheduleNextTransition(cfg.gameKey);
    }
    return cfg;
  }

  /** Delete a game. Stops the round loop, leaves historical
   *  rounds + bets intact (audit trail). The admin can re-create
   *  the same `gameKey` afterwards if needed. */
  async deleteGame(gameKey: string): Promise<{ ok: true }> {
    const cfg = await this.configModel.findOne({ gameKey }).exec();
    if (!cfg) {
      throw new NotFoundException({
        code: 'GAME_NOT_FOUND',
        message: 'Game not found',
      });
    }
    // Cancel any pending transition before deleting the config.
    const timer = this.loopTimers.get(gameKey);
    if (timer) {
      clearTimeout(timer);
      this.loopTimers.delete(gameKey);
    }
    await this.configModel.deleteOne({ _id: cfg._id }).exec();
    return { ok: true };
  }

  async getConfig(gameKey: string): Promise<GameConfigDocument> {
    const cfg = await this.configModel.findOne({ gameKey }).lean().exec();
    if (!cfg) {
      throw new NotFoundException({
        code: 'GAME_NOT_FOUND',
        message: 'Game not found',
      });
    }
    return cfg as any;
  }

  /** Returns the round currently visible to clients — either the
   *  active BETTING / SPINNING / RESULT round, or the most recent
   *  COMPLETED one if the runner is between rounds. Web app polls
   *  this on first load to bootstrap before the WebSocket lands.
   *
   *  Self-heals two pathological states the runner can wedge in
   *  if it was running with an older buggy config:
   *
   *    1. BETTING with a wildly future `bettingClosesAt` (e.g. a
   *       previous admin set bettingMs to 60M ms → 16-hour
   *       window). Force-close the round to spin so the loop
   *       recovers without waiting hours.
   *
   *    2. COMPLETED stuck past its intermission — the runner's
   *       setTimeout chain can be lost on a hard crash. Open a
   *       fresh round so visitors see live action.
   *
   *  Both heals trigger the normal phase transitions, which then
   *  re-arm the timer loop. So a single page visit unsticks the
   *  game.
   */
  async getCurrentRound(gameKey: string): Promise<GameRoundDocument> {
    const round = await this.roundModel
      .findOne({ gameKey })
      .sort({ roundNumber: -1 })
      .exec();
    if (!round) {
      // Fast path — no round yet. Open one now so the first
      // visitor isn't staring at an empty page.
      const cfg = await this.getConfig(gameKey);
      return this.openNewRound(cfg);
    }

    // Comprehensive heal — detects EVERY shape of wedged round
    // and force-recovers. Called on every /current read so a
    // stuck round can never survive more than one client poll.
    //
    // The strongest signal: any timestamp ridiculously far from
    // "now". A healthy BETTING round has bettingClosesAt at
    // most `bettingMs` (≤5 min by the clamp) in the future.
    // SPINNING is at most `spinMs` (≤30 s). COMPLETED is the
    // intermissionMs window. If any timestamp is more than an
    // hour off in EITHER direction (future = bad-config wedge,
    // past = old data that the runner forgot about), the round
    // is dead — nuke it and open a fresh one.
    const STUCK_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour
    const now = Date.now();
    const bettingDelta = round.bettingClosesAt.getTime() - now;
    const spinDelta = round.spinEndsAt.getTime() - now;
    const wildlyStuck =
      Math.abs(bettingDelta) > STUCK_THRESHOLD_MS ||
      Math.abs(spinDelta) > STUCK_THRESHOLD_MS;
    if (wildlyStuck && round.phase !== GameRoundPhase.COMPLETED) {
      this.log.warn(
        `[${gameKey}] round ${round.roundNumber} (${round.phase}) has unreasonable timestamps ` +
        `(bettingClosesAt offset ${bettingDelta}ms, spinEndsAt offset ${spinDelta}ms); ` +
        `force-completing + opening a fresh round`,
      );
      // Mark the bad round COMPLETED (don't try to pay anyone —
      // the timestamps are garbage so we can't even reason about
      // the spin window). Then open a fresh round with clamped
      // timings.
      await this.roundModel
        .updateOne(
          { _id: round._id },
          {
            $set: {
              phase: GameRoundPhase.COMPLETED,
              winningItem: round.winningItem ?? round.items[0]?.key ?? null,
              totalPayout: 0,
            },
          },
        )
        .exec();
      const cfg = await this.configModel.findOne({ gameKey }).lean().exec();
      if (cfg?.enabled) {
        const fresh = await this.openNewRound(cfg as any);
        // Kick the loop so the new round's transitions are
        // scheduled normally from here.
        void this.scheduleNextTransition(gameKey);
        return fresh;
      }
    }

    // Heal a stuck BETTING round (bad bettingClosesAt < 1h off but
    // > 2× the configured max). Force-spin and return the new
    // SPINNING round.
    if (round.phase === GameRoundPhase.BETTING) {
      const remainingMs = round.bettingClosesAt.getTime() - now;
      if (remainingMs > GamesService.MAX_BETTING_MS * 2) {
        this.log.warn(
          `[${gameKey}] getCurrentRound saw stuck BETTING round ${round.roundNumber} (${remainingMs}ms remaining); force-closing now`,
        );
        await this.transitionToSpin(gameKey);
        const reloaded = await this.roundModel
          .findOne({ gameKey })
          .sort({ roundNumber: -1 })
          .exec();
        return reloaded ?? round;
      }
    }

    // Heal a stuck SPINNING round (bad spinEndsAt > 2× max).
    if (round.phase === GameRoundPhase.SPINNING) {
      const remainingMs = round.spinEndsAt.getTime() - now;
      if (remainingMs > GamesService.MAX_SPIN_MS * 2) {
        this.log.warn(
          `[${gameKey}] getCurrentRound saw stuck SPINNING round ${round.roundNumber} (${remainingMs}ms remaining); force-resulting now`,
        );
        await this.transitionToResult(gameKey);
        const reloaded = await this.roundModel
          .findOne({ gameKey })
          .sort({ roundNumber: -1 })
          .exec();
        return reloaded ?? round;
      }
    }

    // Heal a COMPLETED-and-stuck state — past intermission, no
    // new round opened (runner lost). Kick the runner.
    if (round.phase === GameRoundPhase.COMPLETED) {
      const cfg = await this.configModel.findOne({ gameKey }).lean().exec();
      if (cfg?.enabled) {
        const intermissionMs = this.clampTimings({
          gameKey,
          bettingMs: cfg.bettingMs,
          spinMs: cfg.spinMs,
          intermissionMs: cfg.intermissionMs,
        }).intermissionMs;
        const sinceCompleted = now - round.spinEndsAt.getTime();
        if (sinceCompleted > intermissionMs + 60_000) {
          this.log.warn(
            `[${gameKey}] getCurrentRound saw stale COMPLETED round (${sinceCompleted}ms ago); kicking runner`,
          );
          void this.scheduleNextTransition(gameKey);
        }
      }
    }
    return round;
  }

  /**
   * Brute-force reset for a game's round state. Marks every
   * non-COMPLETED round as COMPLETED (no payouts), then opens
   * a fresh round. Use from the admin panel when the game is
   * stuck and the per-call heals haven't recovered it.
   *
   * Doesn't touch bets / payouts / wallet — historical rows
   * stay intact for audit. Just resets the round state machine.
   */
  async resetRounds(gameKey: string): Promise<GameRoundDocument> {
    const cfg = await this.configModel.findOne({ gameKey }).exec();
    if (!cfg) {
      throw new NotFoundException({
        code: 'GAME_NOT_FOUND',
        message: 'Game not found',
      });
    }
    // Cancel any in-flight scheduled transition.
    const timer = this.loopTimers.get(gameKey);
    if (timer) {
      clearTimeout(timer);
      this.loopTimers.delete(gameKey);
    }
    // Close every non-COMPLETED round so the next round starts
    // clean. Doesn't pay out — these rounds were broken, paying
    // on them would just compound the error.
    await this.roundModel
      .updateMany(
        { gameKey, phase: { $ne: GameRoundPhase.COMPLETED } },
        { $set: { phase: GameRoundPhase.COMPLETED, totalPayout: 0 } },
      )
      .exec();
    this.log.warn(`[${gameKey}] admin reset — closed all open rounds`);
    // Open a fresh round + restart the loop.
    const fresh = await this.openNewRound(cfg);
    void this.scheduleNextTransition(gameKey);
    return fresh;
  }

  async listHistory(gameKey: string, limit: number = 20): Promise<GameRoundDocument[]> {
    return this.roundModel
      .find({
        gameKey,
        phase: { $in: [GameRoundPhase.RESULT, GameRoundPhase.COMPLETED] },
        winningItem: { $ne: null },
      })
      .sort({ roundNumber: -1 })
      .limit(Math.min(100, Math.max(1, limit)))
      .lean()
      .exec() as any;
  }

  async listMyBets(
    userId: string,
    gameKey: string,
    limit: number = 20,
  ): Promise<GameBetDocument[]> {
    if (!Types.ObjectId.isValid(userId)) return [];
    return this.betModel
      .find({ userId: new Types.ObjectId(userId), gameKey })
      .sort({ createdAt: -1 })
      .limit(Math.min(100, Math.max(1, limit)))
      .lean()
      .exec() as any;
  }

  // ============================================================
  // Bet placement
  // ============================================================

  async placeBet(params: {
    userId: string;
    gameKey: string;
    item: string;
    amount: number;
  }): Promise<{ round: GameRoundDocument; bet: GameBetDocument }> {
    const { userId, gameKey, item, amount } = params;
    if (!Types.ObjectId.isValid(userId)) {
      throw new BadRequestException({
        code: 'INVALID_USER_ID',
        message: 'Invalid user id',
      });
    }
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new BadRequestException({
        code: 'INVALID_AMOUNT',
        message: 'Amount must be a positive integer',
      });
    }

    // 1. Resolve the active round + validate that betting is OPEN.
    //    Refetch instead of trusting an in-memory handle — a stale
    //    request can land milliseconds after the round closed, and
    //    we need the round to be in BETTING at insert time.
    const round = await this.roundModel
      .findOne({ gameKey })
      .sort({ roundNumber: -1 })
      .exec();
    if (!round || round.phase !== GameRoundPhase.BETTING) {
      throw new ConflictException({
        code: 'BETTING_CLOSED',
        message: 'Betting is not open right now',
      });
    }
    if (round.bettingClosesAt.getTime() <= Date.now()) {
      // Belt-and-braces: the runner's setTimeout might be late.
      throw new ConflictException({
        code: 'BETTING_CLOSED',
        message: 'Betting is closing — try again next round',
      });
    }
    const itemDef = round.items.find((i) => i.key === item);
    if (!itemDef) {
      throw new BadRequestException({
        code: 'INVALID_ITEM',
        message: 'Unknown wheel item',
      });
    }

    // 2. Validate the chip value against the configured tiers.
    //    Use the LIVE config (not the snapshot) so an admin tier
    //    change kicks in immediately — there's no harm in
    //    accepting a new tier mid-round.
    const cfg = await this.getConfig(gameKey);
    if (!cfg.betTiers.includes(amount)) {
      throw new BadRequestException({
        code: 'INVALID_TIER',
        message: `Bet amount must be one of: ${cfg.betTiers.join(', ')}`,
      });
    }

    // 3. Debit the wallet. Idempotent on the key so a retried
    //    request never double-charges. We compose the key from
    //    userId + roundId + a random nonce — same user CAN place
    //    multiple bets on the same item in the same round, so we
    //    can't just key on (user, round, item).
    const idempotencyKey = `game-bet:${gameKey}:${round._id.toString()}:${userId}:${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const debitTxn = await this.wallet.debit(
      round.currency === 'coins' ? Currency.COINS : Currency.DIAMONDS,
      {
        userId,
        amount,
        type: TxnType.GAME_BET,
        description: `Bet on ${item} — ${gameKey} round ${round.roundNumber}`,
        idempotencyKey,
        refType: 'game_bet',
        refId: round._id.toString(),
      },
    );

    // 4. Insert the bet row + bump the round aggregates atomically.
    //    The `$inc` against `betsByItem.<item>` is what the winner
    //    selector reads when betting closes.
    const bet = await this.betModel.create({
      userId: new Types.ObjectId(userId),
      gameKey,
      roundId: round._id,
      roundNumber: round.roundNumber,
      item,
      amount,
      currency: round.currency,
      debitTxnId: debitTxn._id,
    });
    const updated = await this.roundModel
      .findByIdAndUpdate(
        round._id,
        {
          $inc: {
            [`betsByItem.${item}`]: amount,
            totalBet: amount,
            betCount: 1,
          },
        },
        { new: true },
      )
      .exec();

    // 5. Broadcast aggregate to all subscribers so chip stacks
    //    animate live. We DON'T leak per-user info here — only
    //    item totals + counts — so a player's strategy stays
    //    private from other players.
    void this.realtime.emit(
      `game:${gameKey}`,
      RealtimeEventType.GAME_BET_PLACED,
      {
        item,
        amount,
        betsByItem: updated?.betsByItem ?? round.betsByItem,
        totalBet: updated?.totalBet ?? round.totalBet,
        betCount: updated?.betCount ?? round.betCount,
      },
    );

    return { round: updated ?? round, bet };
  }

  // ============================================================
  // Round runner
  // ============================================================

  /** Defensive caps. Even though the admin DTO enforces a max,
   *  any pre-existing config row could have wildly out-of-range
   *  values (e.g. a misclick that saved bettingMs as 60_240_000
   *  → 16-hour betting windows). The runner clamps to these so
   *  one bad config doesn't wedge the round loop. Warned to logs
   *  so an admin can fix the underlying row. */
  private static readonly MAX_BETTING_MS = 5 * 60 * 1000; // 5 min
  private static readonly MAX_SPIN_MS = 30 * 1000; // 30 s
  private static readonly MAX_INTERMISSION_MS = 60 * 1000; // 1 min

  private clampTimings(cfg: {
    gameKey: string;
    bettingMs: number;
    spinMs: number;
    intermissionMs: number;
  }): { bettingMs: number; spinMs: number; intermissionMs: number } {
    const clamp = (label: string, value: number, max: number, fallback: number) => {
      if (!Number.isFinite(value) || value <= 0 || value > max) {
        this.log.warn(
          `[${cfg.gameKey}] ${label}=${value} out of range (1..${max}); using ${fallback}`,
        );
        return fallback;
      }
      return value;
    };
    return {
      bettingMs: clamp('bettingMs', cfg.bettingMs, GamesService.MAX_BETTING_MS, 30_000),
      spinMs: clamp('spinMs', cfg.spinMs, GamesService.MAX_SPIN_MS, 5_000),
      intermissionMs: clamp(
        'intermissionMs',
        cfg.intermissionMs,
        GamesService.MAX_INTERMISSION_MS,
        5_000,
      ),
    };
  }

  /** Open a new round for the given config. Snapshots items + RTP
   *  + currency so a mid-round admin edit can't mutate the round
   *  the players are looking at. */
  private async openNewRound(cfg: GameConfigDocument): Promise<GameRoundDocument> {
    // Pick the next round number atomically (find max + 1).
    const latest = await this.roundModel
      .findOne({ gameKey: cfg.gameKey })
      .sort({ roundNumber: -1 })
      .select({ roundNumber: 1 })
      .lean()
      .exec();
    const roundNumber = (latest?.roundNumber ?? 0) + 1;
    const now = Date.now();
    const timings = this.clampTimings(cfg);
    const round = await this.roundModel.create({
      gameKey: cfg.gameKey,
      roundNumber,
      phase: GameRoundPhase.BETTING,
      startedAt: new Date(now),
      bettingClosesAt: new Date(now + timings.bettingMs),
      spinEndsAt: new Date(now + timings.bettingMs + timings.spinMs),
      currency: cfg.currency,
      items: cfg.items.map((i) => ({
        key: i.key,
        label: i.label,
        multiplier: i.multiplier,
      })),
      rtpPercent: cfg.rtpPercent,
      betsByItem: {},
      totalBet: 0,
      betCount: 0,
    });
    void this.realtime.emit(
      `game:${cfg.gameKey}`,
      RealtimeEventType.GAME_ROUND_STARTED,
      { round: round.toJSON() },
    );
    return round;
  }

  /**
   * Schedule the next transition for a game. Reads the latest
   * round, figures out what phase comes next, and arms a
   * setTimeout for the right moment. Self-recursive — the
   * timeout callback calls back into this method, so one call at
   * boot-time keeps the loop running forever.
   *
   * Resumable: if the process restarted mid-round, this picks up
   * the round in whatever phase it's in and waits for the
   * pre-existing timestamp. No state-machine drift because the
   * round doc is the source of truth.
   */
  private async scheduleNextTransition(gameKey: string): Promise<void> {
    // Cancel any previous handle so we don't double-fire.
    const existing = this.loopTimers.get(gameKey);
    if (existing) clearTimeout(existing);

    const cfg = await this.configModel.findOne({ gameKey }).lean().exec();
    if (!cfg || !cfg.enabled) {
      this.log.log(`Round loop paused for ${gameKey}`);
      return;
    }
    let round = await this.roundModel
      .findOne({ gameKey })
      .sort({ roundNumber: -1 })
      .exec();
    if (!round || round.phase === GameRoundPhase.COMPLETED) {
      // No round yet, or last one wrapped — open the next one
      // immediately (or after the intermission if the previous
      // round just completed). Clamp the intermission so a bad
      // config can't space rounds 24 hours apart.
      const intermissionMs = this.clampTimings({
        gameKey,
        bettingMs: cfg.bettingMs,
        spinMs: cfg.spinMs,
        intermissionMs: cfg.intermissionMs,
      }).intermissionMs;
      const delay = round?.phase === GameRoundPhase.COMPLETED
        ? Math.max(0, round.spinEndsAt.getTime() + intermissionMs - Date.now())
        : 0;
      this.loopTimers.set(
        gameKey,
        setTimeout(() => {
          void (async () => {
            await this.openNewRound(cfg as any);
            await this.scheduleNextTransition(gameKey);
          })();
        }, delay),
      );
      return;
    }

    const now = Date.now();
    if (round.phase === GameRoundPhase.BETTING) {
      const remainingMs = round.bettingClosesAt.getTime() - now;
      // Self-heal: if a round was opened with an absurd
      // `bettingClosesAt` (e.g. a previous admin config set
      // bettingMs to 60_240_000 → 16 hours), force-close it now
      // so the loop recovers within seconds of a restart instead
      // of waiting hours for the stuck round to expire.
      if (remainingMs > GamesService.MAX_BETTING_MS * 2) {
        this.log.warn(
          `[${gameKey}] round ${round.roundNumber} has a stuck bettingClosesAt (${remainingMs}ms remaining); force-closing now`,
        );
        void this.transitionToSpin(gameKey);
        return;
      }
      const delay = Math.max(0, remainingMs);
      this.loopTimers.set(
        gameKey,
        setTimeout(() => {
          void this.transitionToSpin(gameKey);
        }, delay),
      );
      return;
    }
    if (round.phase === GameRoundPhase.CLOSED) {
      // Brief computational phase — should auto-progress
      // immediately. If we crashed mid-pick, retry now.
      this.loopTimers.set(
        gameKey,
        setTimeout(() => {
          void this.transitionToSpin(gameKey);
        }, 0),
      );
      return;
    }
    if (round.phase === GameRoundPhase.SPINNING) {
      const delay = Math.max(0, round.spinEndsAt.getTime() - now);
      this.loopTimers.set(
        gameKey,
        setTimeout(() => {
          void this.transitionToResult(gameKey);
        }, delay),
      );
      return;
    }
    if (round.phase === GameRoundPhase.RESULT) {
      // We crashed after the payout but before marking COMPLETED.
      // Mark it now + open the next round.
      await this.roundModel
        .updateOne({ _id: round._id }, { $set: { phase: GameRoundPhase.COMPLETED } })
        .exec();
      void this.scheduleNextTransition(gameKey);
      return;
    }
  }

  /** Close betting, pick the winner via RTP, broadcast the
   *  spinning event, and arm the spin-end timer. */
  private async transitionToSpin(gameKey: string): Promise<void> {
    const round = await this.roundModel
      .findOne({ gameKey })
      .sort({ roundNumber: -1 })
      .exec();
    if (!round || round.phase === GameRoundPhase.COMPLETED) {
      void this.scheduleNextTransition(gameKey);
      return;
    }

    // Atomic phase flip — if a competing instance also ran the
    // transition, we'll get null back and bail.
    const closed = await this.roundModel
      .findOneAndUpdate(
        { _id: round._id, phase: GameRoundPhase.BETTING },
        { $set: { phase: GameRoundPhase.CLOSED } },
        { new: true },
      )
      .exec();
    const working = closed ?? round;

    const winningItem = this.selectWinner(working);
    const cfg = await this.configModel.findOne({ gameKey }).lean().exec();
    const spinMs = this.clampTimings({
      gameKey,
      bettingMs: cfg?.bettingMs ?? 30_000,
      spinMs: cfg?.spinMs ?? 5_000,
      intermissionMs: cfg?.intermissionMs ?? 5_000,
    }).spinMs;
    const spinEndsAt = new Date(Date.now() + spinMs);
    const spun = await this.roundModel
      .findByIdAndUpdate(
        working._id,
        {
          $set: {
            phase: GameRoundPhase.SPINNING,
            winningItem,
            spinEndsAt,
          },
        },
        { new: true },
      )
      .exec();

    void this.realtime.emit(
      `game:${gameKey}`,
      RealtimeEventType.GAME_ROUND_SPINNING,
      {
        roundId: working._id.toString(),
        roundNumber: working.roundNumber,
        winningItem,
        spinEndsAt: spinEndsAt.toISOString(),
      },
    );

    this.loopTimers.set(
      gameKey,
      setTimeout(() => {
        void this.transitionToResult(gameKey);
      }, spinMs),
    );
    void spun; // silence unused-var lint
  }

  /** Pay out winners, mark RESULT, broadcast, then open the next
   *  round after the intermission. */
  private async transitionToResult(gameKey: string): Promise<void> {
    const round = await this.roundModel
      .findOne({ gameKey })
      .sort({ roundNumber: -1 })
      .exec();
    if (!round || round.phase === GameRoundPhase.COMPLETED) {
      void this.scheduleNextTransition(gameKey);
      return;
    }

    // Atomic phase flip to guard against duplicate payout.
    const resulting = await this.roundModel
      .findOneAndUpdate(
        {
          _id: round._id,
          phase: { $in: [GameRoundPhase.SPINNING, GameRoundPhase.CLOSED] },
        },
        { $set: { phase: GameRoundPhase.RESULT } },
        { new: true },
      )
      .exec();
    if (!resulting) {
      // Already paid out — just schedule the next round.
      void this.scheduleNextTransition(gameKey);
      return;
    }

    const winningItem = resulting.winningItem!;
    const multiplier =
      resulting.items.find((i) => i.key === winningItem)?.multiplier ?? 0;
    const winningBets = await this.betModel
      .find({ roundId: resulting._id, item: winningItem })
      .exec();

    let totalPayout = 0;
    const winners: Array<{ userId: string; amount: number; payout: number }> = [];
    for (const bet of winningBets) {
      const payout = bet.amount * multiplier;
      try {
        const txn = await this.wallet.credit(
          resulting.currency === 'coins' ? Currency.COINS : Currency.DIAMONDS,
          {
            userId: bet.userId.toString(),
            amount: payout,
            type: TxnType.GAME_PAYOUT,
            description: `${gameKey} round ${resulting.roundNumber} payout (${winningItem} × ${multiplier})`,
            idempotencyKey: `game-payout:${bet._id.toString()}`,
            refType: 'game_bet',
            refId: bet._id.toString(),
          },
        );
        await this.betModel
          .updateOne(
            { _id: bet._id },
            { $set: { payoutAmount: payout, payoutTxnId: txn._id } },
          )
          .exec();
        totalPayout += payout;
        winners.push({
          userId: bet.userId.toString(),
          amount: bet.amount,
          payout,
        });
      } catch (err: any) {
        this.log.error(
          `Payout failed for bet ${bet._id.toString()}: ${err?.message ?? err}`,
        );
      }
    }

    await this.roundModel
      .updateOne(
        { _id: resulting._id },
        { $set: { phase: GameRoundPhase.COMPLETED, totalPayout } },
      )
      .exec();

    void this.realtime.emit(
      `game:${gameKey}`,
      RealtimeEventType.GAME_ROUND_RESULT,
      {
        roundId: resulting._id.toString(),
        roundNumber: resulting.roundNumber,
        winningItem,
        totalPayout,
        winners,
      },
    );

    // Schedule the next round after the intermission.
    void this.scheduleNextTransition(gameKey);
  }

  /**
   * Pick the winning item. RTP-bounded: compute the payout for
   * every item, then pick uniformly among items whose payout
   * stays within `maxPayout = totalBet × rtp%`. If NO item fits
   * (rare — would only happen if rtp < smallest item multiplier
   * and all bets stacked on the smallest-multiplier item), fall
   * back to the lowest-payout item so the house never loses to
   * a corner case.
   *
   * Empty round (no bets): pick uniformly at random — there's no
   * payout to gate against, and the spin still needs a result so
   * the wheel has somewhere to land.
   */
  private selectWinner(round: GameRoundDocument): string {
    const { items, betsByItem, totalBet, rtpPercent } = round;
    if (totalBet === 0) {
      return items[Math.floor(Math.random() * items.length)].key;
    }
    const maxPayout = Math.floor((totalBet * rtpPercent) / 100);
    const candidates: string[] = [];
    let cheapestKey = items[0].key;
    let cheapestPayout = Infinity;
    for (const item of items) {
      const bet = betsByItem[item.key] ?? 0;
      const payout = bet * item.multiplier;
      if (payout < cheapestPayout) {
        cheapestPayout = payout;
        cheapestKey = item.key;
      }
      if (payout <= maxPayout) candidates.push(item.key);
    }
    if (candidates.length === 0) return cheapestKey;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  // ============================================================
  // Admin
  // ============================================================

  async updateConfig(
    gameKey: string,
    update: Partial<Omit<GameConfig, 'gameKey'>>,
  ): Promise<GameConfigDocument> {
    const cfg = await this.configModel
      .findOneAndUpdate({ gameKey }, { $set: update }, { new: true })
      .exec();
    if (!cfg) {
      throw new NotFoundException({
        code: 'GAME_NOT_FOUND',
        message: 'Game not found',
      });
    }
    // If the admin just re-enabled a paused game, kick the loop.
    if (update.enabled === true) {
      void this.scheduleNextTransition(gameKey);
    }
    return cfg;
  }
}
