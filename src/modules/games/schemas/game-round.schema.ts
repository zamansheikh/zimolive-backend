import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type GameRoundDocument = HydratedDocument<GameRound>;

/**
 * Phases of a single round. The runner transitions through these
 * in order and broadcasts a `game.round.*` realtime event on each
 * boundary so the web app can drive its animations off a single
 * authoritative timeline.
 *
 *   • BETTING       — chips open; players can call POST /bet.
 *   • CLOSED        — betting window ended; server is computing
 *                     the winner. Brief (~tens of ms) — exists so
 *                     a stray bet that landed mid-transition can
 *                     be rejected with a clear code.
 *   • SPINNING      — winner picked, broadcast, wheel animates on
 *                     every client. Server holds payouts here so
 *                     the win highlight syncs with the spin landing.
 *   • RESULT        — payouts credited, winners broadcast.
 *   • COMPLETED     — round closed; next round opens after the
 *                     config's intermissionMs.
 */
export enum GameRoundPhase {
  BETTING = 'betting',
  CLOSED = 'closed',
  SPINNING = 'spinning',
  RESULT = 'result',
  COMPLETED = 'completed',
}

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
export class GameRound {
  @Prop({ type: String, required: true, index: true })
  gameKey!: string;

  /** Monotonic round number per game. Incremented atomically in
   *  the round runner so two concurrent processes can't both think
   *  they're starting round N+1. */
  @Prop({ type: Number, required: true })
  roundNumber!: number;

  @Prop({
    type: String,
    enum: Object.values(GameRoundPhase),
    required: true,
    default: GameRoundPhase.BETTING,
  })
  phase!: GameRoundPhase;

  @Prop({ type: Date, required: true })
  startedAt!: Date;

  /** Absolute moment betting closes. UI uses this as the
   *  countdown anchor instead of a relative duration so a brief
   *  socket gap doesn't desync the local timer. */
  @Prop({ type: Date, required: true })
  bettingClosesAt!: Date;

  /** When the spin animation visually ends + payouts are
   *  credited. */
  @Prop({ type: Date, required: true })
  spinEndsAt!: Date;

  /** Configured currency at round-open time. Snapshotted so a
   *  mid-round admin currency change doesn't pay diamonds for
   *  coins-debited bets. */
  @Prop({ type: String, required: true })
  currency!: 'coins' | 'diamonds';

  /** Snapshot of items + multipliers at round-open time. Same
   *  reasoning as `currency` — config edits affect the NEXT
   *  round, not the in-flight one. */
  @Prop({
    type: [
      {
        key: { type: String, required: true },
        label: { type: String, required: true },
        multiplier: { type: Number, required: true },
        _id: false,
      },
    ],
    required: true,
  })
  items!: Array<{ key: string; label: string; multiplier: number }>;

  /** Snapshot of RTP target so a later change doesn't rewrite
   *  historical analysis. */
  @Prop({ type: Number, required: true })
  rtpPercent!: number;

  /** Per-item bet totals. Updated atomically on every bet via
   *  `$inc`. Used both by the winner selector (max-payout
   *  computation) and the UI (chip stack visualisation). */
  @Prop({
    type: Object,
    required: true,
    default: {},
  })
  betsByItem!: Record<string, number>;

  /** Number of bets placed in this round, across all items.
   *  Tracked for the UI's "X players this round" indicator. */
  @Prop({ type: Number, required: true, default: 0 })
  betCount!: number;

  /** Aggregate of every wagered coin/diamond — equal to
   *  sum(betsByItem). Tracked for the RTP calculation and the
   *  admin's round-revenue view. */
  @Prop({ type: Number, required: true, default: 0 })
  totalBet!: number;

  /** Server-picked winning item, written once the spin phase
   *  starts. Null while betting is still open. */
  @Prop({ type: String, default: null })
  winningItem!: string | null;

  /** Total payout credited to winners this round. Set once the
   *  RESULT phase pays out. */
  @Prop({ type: Number, default: 0 })
  totalPayout!: number;

  /** Winners of this round, enriched with a display name, persisted
   *  once payouts settle. Drives the in-game "who won" popup (the
   *  game polls /current, so it reads this off the round rather than
   *  the realtime event). Capped + sorted by payout desc on write.
   *  Empty until RESULT. Best-effort: a name-lookup failure leaves
   *  this empty but never blocks payouts or round completion. */
  @Prop({
    type: [
      {
        userId: { type: String, required: true },
        name: { type: String, required: true },
        amount: { type: Number, required: true },
        payout: { type: Number, required: true },
        _id: false,
      },
    ],
    default: [],
  })
  winners!: Array<{
    userId: string;
    name: string;
    amount: number;
    payout: number;
  }>;
}

export const GameRoundSchema = SchemaFactory.createForClass(GameRound);
// Cheap lookup of the "current" / "most recent" round per game.
GameRoundSchema.index({ gameKey: 1, roundNumber: -1 });
GameRoundSchema.index({ gameKey: 1, phase: 1 });
