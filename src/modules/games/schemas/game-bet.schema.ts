import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type GameBetDocument = HydratedDocument<GameBet>;

/**
 * One row per bet placed. Append-only — never updated, only
 * marked with `payoutAmount` when the round resolves. The wallet
 * already holds the source of truth for money; this collection
 * exists for the "my bets" history endpoint, the admin per-round
 * audit view, and the payout pass (which finds all bets for the
 * winning item and credits each player).
 */
@Schema({
  timestamps: true,
  toJSON: {
    transform: (_doc, ret: Record<string, any>) => {
      ret.id = ret._id?.toString();
      ret.userId = ret.userId?.toString?.() ?? ret.userId;
      ret.roundId = ret.roundId?.toString?.() ?? ret.roundId;
      delete ret._id;
      delete ret.__v;
      return ret;
    },
  },
})
export class GameBet {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId!: Types.ObjectId;

  @Prop({ type: String, required: true, index: true })
  gameKey!: string;

  @Prop({ type: Types.ObjectId, ref: 'GameRound', required: true, index: true })
  roundId!: Types.ObjectId;

  /** Denormalised round number — speeds the per-user history
   *  endpoint up to a single indexed query without joining
   *  rounds. */
  @Prop({ type: Number, required: true })
  roundNumber!: number;

  /** Wheel item key the user bet on. References the item.key
   *  inside the round's snapshot. */
  @Prop({ type: String, required: true })
  item!: string;

  /** Wagered amount in the round's currency. Already debited from
   *  the wallet — `wallet.debit` ran before the bet was inserted. */
  @Prop({ type: Number, required: true, min: 1 })
  amount!: number;

  /** Snapshot of the bet's currency at placement time. Avoids
   *  having to dereference the round just to know what the
   *  history row paid out in. */
  @Prop({ type: String, enum: ['coins', 'diamonds'], required: true })
  currency!: 'coins' | 'diamonds';

  /** Wallet txn id for the debit. Lets us reverse the bet if a
   *  rare round-cancel ever happens. */
  @Prop({ type: Types.ObjectId, required: true })
  debitTxnId!: Types.ObjectId;

  /** Payout credited when the round resolves — 0 for losers,
   *  amount × multiplier for winners. Set once during the RESULT
   *  phase; never edited afterwards. */
  @Prop({ type: Number, default: 0 })
  payoutAmount!: number;

  /** Wallet txn id for the payout credit. Null for losing bets. */
  @Prop({ type: Types.ObjectId, default: null })
  payoutTxnId!: Types.ObjectId | null;
}

export const GameBetSchema = SchemaFactory.createForClass(GameBet);
GameBetSchema.index({ roundId: 1, item: 1 });
GameBetSchema.index({ userId: 1, gameKey: 1, createdAt: -1 });
