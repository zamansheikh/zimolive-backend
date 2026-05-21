import {
  BadRequestException,
  ForbiddenException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, FilterQuery, Model, Types } from 'mongoose';
import { nanoid } from 'nanoid';

import { HonorsService } from '../honors/honors.service';
import { HonorMetric } from '../honors/schemas/honor-item.schema';
import { Wallet, WalletDocument } from './schemas/wallet.schema';
import {
  Currency,
  Transaction,
  TransactionDocument,
  TxnDirection,
  TxnStatus,
  TxnType,
} from './schemas/transaction.schema';

interface CreditDebitParams {
  userId: string;
  amount: number;
  type: TxnType;
  description?: string;
  idempotencyKey: string;
  /**
   * Optional grouping key. When two related entries should appear as
   * one logical event in the ledger (e.g. recharge base + recharge
   * bonus, gift sender debit + receiver credit), pass the same
   * correlationId on both. Defaults to `idempotencyKey` for singleton
   * operations — that's the legacy behaviour and stays unchanged.
   */
  correlationId?: string;
  refType?: string;
  refId?: string;
  performedBy?: string;
  performedByIp?: string;
}

interface ListTransactionsParams {
  userId?: string;
  walletId?: string;
  currency?: Currency;
  type?: TxnType;
  direction?: TxnDirection;
  from?: Date;
  to?: Date;
  page?: number;
  limit?: number;
}

interface GiftTransferParams {
  senderUserId: string;
  receiverUserId: string;
  coinAmount: number;
  diamondReward: number;
  giftId?: string;
  idempotencyKey: string;
  description?: string;
}

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  constructor(
    @InjectModel(Wallet.name) private readonly walletModel: Model<WalletDocument>,
    @InjectModel(Transaction.name) private readonly txnModel: Model<TransactionDocument>,
    @InjectConnection() private readonly connection: Connection,
    // forwardRef so the runtime-only edge (wallet → honors → wallet
    // schema) doesn't get tripped by the module-init order checker.
    // The schema is registered directly on HonorsModule's
    // forFeature, so no actual import cycle exists at module level
    // — this is just to keep Nest's DI graph happy.
    @Inject(forwardRef(() => HonorsService))
    private readonly honors: HonorsService,
  ) {}

  // ----------- Wallet lookup / lazy create -----------

  /** Returns the wallet for a user, creating an empty one if missing. */
  async getOrCreate(userId: string): Promise<WalletDocument> {
    if (!Types.ObjectId.isValid(userId)) {
      throw new BadRequestException({ code: 'INVALID_USER_ID', message: 'Invalid user id' });
    }
    const userObjId = new Types.ObjectId(userId);
    return this.walletModel
      .findOneAndUpdate(
        { userId: userObjId },
        { $setOnInsert: { userId: userObjId } },
        { new: true, upsert: true },
      )
      .exec();
  }

  async findByUserId(userId: string): Promise<WalletDocument | null> {
    if (!Types.ObjectId.isValid(userId)) return null;
    return this.walletModel.findOne({ userId: new Types.ObjectId(userId) }).exec();
  }

  /**
   * Coin/diamond balances for many users in one query — used to enrich list
   * views (e.g. the admin App Users table) without an N+1 fetch. Users with
   * no wallet row simply don't appear in the map (treat as 0).
   */
  async balancesByUserIds(
    userIds: string[],
  ): Promise<Map<string, { coins: number; diamonds: number }>> {
    const ids = userIds
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));
    const out = new Map<string, { coins: number; diamonds: number }>();
    if (ids.length === 0) return out;
    const rows = await this.walletModel
      .find({ userId: { $in: ids } })
      .select({ userId: 1, coins: 1, diamonds: 1 })
      .lean()
      .exec();
    for (const w of rows) {
      out.set(w.userId.toString(), {
        coins: w.coins ?? 0,
        diamonds: w.diamonds ?? 0,
      });
    }
    return out;
  }

  async list(params: { page?: number; limit?: number; minCoins?: number; minDiamonds?: number }) {
    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(100, Math.max(1, params.limit ?? 20));
    const skip = (page - 1) * limit;

    const filter: FilterQuery<WalletDocument> = {};
    if (params.minCoins !== undefined) filter.coins = { $gte: params.minCoins };
    if (params.minDiamonds !== undefined) filter.diamonds = { $gte: params.minDiamonds };

    const [items, total] = await Promise.all([
      this.walletModel.find(filter).sort({ coins: -1 }).skip(skip).limit(limit).exec(),
      this.walletModel.countDocuments(filter).exec(),
    ]);
    return { items, page, limit, total };
  }

  // ----------- Single-wallet credit / debit -----------

  /**
   * Atomic single-wallet credit. Idempotent on `idempotencyKey`.
   * If a transaction with the same key already exists, returns it without re-applying.
   */
  async credit(currency: Currency, p: CreditDebitParams): Promise<TransactionDocument> {
    return this.applyDelta(currency, TxnDirection.CREDIT, p);
  }

  /**
   * Atomic single-wallet debit. Throws InsufficientBalance if not enough funds.
   */
  async debit(currency: Currency, p: CreditDebitParams): Promise<TransactionDocument> {
    return this.applyDelta(currency, TxnDirection.DEBIT, p);
  }

  private async applyDelta(
    currency: Currency,
    direction: TxnDirection,
    p: CreditDebitParams,
  ): Promise<TransactionDocument> {
    if (p.amount <= 0) {
      throw new BadRequestException({ code: 'AMOUNT_NON_POSITIVE', message: 'Amount must be > 0' });
    }
    if (!Types.ObjectId.isValid(p.userId)) {
      throw new BadRequestException({ code: 'INVALID_USER_ID', message: 'Invalid user id' });
    }

    // 1. Idempotency check — if a txn already exists for this key, return it.
    const existing = await this.txnModel.findOne({ idempotencyKey: p.idempotencyKey }).exec();
    if (existing) return existing;

    // 2. Atomic wallet update with frozen + (for debit) sufficient-balance guard.
    const userObjId = new Types.ObjectId(p.userId);
    const isCredit = direction === TxnDirection.CREDIT;
    const balanceField = currency;
    const lifetimeField = this.lifetimeFieldFor(currency, direction, p.type);

    const updateFilter: FilterQuery<WalletDocument> = { userId: userObjId, frozen: false };
    if (!isCredit) {
      updateFilter[balanceField] = { $gte: p.amount };
    }

    const inc: Record<string, number> = {
      [balanceField]: isCredit ? p.amount : -p.amount,
    };
    if (lifetimeField) inc[lifetimeField] = p.amount;

    const updated = await this.walletModel
      .findOneAndUpdate(updateFilter, { $inc: inc, $setOnInsert: { userId: userObjId } }, {
        new: true,
        upsert: isCredit, // only allow upsert on credit (we shouldn't create wallet to debit it)
      })
      .exec();

    if (!updated) {
      // Either frozen, or insufficient balance. Distinguish.
      const wallet = await this.findByUserId(p.userId);
      if (wallet?.frozen) {
        throw new ForbiddenException({ code: 'WALLET_FROZEN', message: 'Wallet is frozen' });
      }
      throw new BadRequestException({
        code: 'INSUFFICIENT_BALANCE',
        message: `Not enough ${currency}`,
        details: {
          required: p.amount,
          available: wallet?.[balanceField] ?? 0,
        },
      });
    }

    // 3. Write ledger entry. Idempotency key uniqueness will catch concurrent retries.
    try {
      const txn = await this.txnModel.create({
        idempotencyKey: p.idempotencyKey,
        // When the caller groups multiple entries (e.g. RC recharge +
        // its bonus) they pass `correlationId` explicitly. Singletons
        // (admin mints, etc.) leave it blank and re-use the idempotency
        // key — same legacy behaviour.
        correlationId: p.correlationId ?? p.idempotencyKey,
        walletId: updated._id,
        userId: userObjId,
        currency,
        direction,
        amount: p.amount,
        type: p.type,
        description: p.description ?? '',
        refType: p.refType ?? null,
        refId: p.refId && Types.ObjectId.isValid(p.refId) ? new Types.ObjectId(p.refId) : null,
        balanceAfter: updated[balanceField],
        performedBy:
          p.performedBy && Types.ObjectId.isValid(p.performedBy)
            ? new Types.ObjectId(p.performedBy)
            : null,
        performedByIp: p.performedByIp ?? '',
        status: TxnStatus.COMPLETED,
      });
      // Honor evaluation hook — fire-and-forget so the wallet
      // write isn't gated on the evaluator. Maps the txn type to
      // the matching honor metric (recharge → COINS_RECHARGED,
      // gift send → COINS_SENT, gift receive → DIAMONDS_RECEIVED).
      // Failures are logged but don't propagate.
      const metric = this._honorMetricFor(currency, direction, p.type);
      if (metric) {
        void this.honors
          .evaluateUser(p.userId, metric)
          .catch((e) =>
            this.logger.warn(
              `Honor evaluate failed for ${p.userId}/${metric}: ${(e as Error).message}`,
            ),
          );
      }
      return txn;
    } catch (err: any) {
      // Duplicate key (concurrent request slipped through). Reverse the wallet update and return existing.
      if (err?.code === 11000) {
        await this.walletModel
          .updateOne(
            { _id: updated._id },
            {
              $inc: {
                [balanceField]: isCredit ? -p.amount : p.amount,
                ...(lifetimeField ? { [lifetimeField]: -p.amount } : {}),
              },
            },
          )
          .exec();
        const existingTxn = await this.txnModel.findOne({ idempotencyKey: p.idempotencyKey }).exec();
        if (existingTxn) return existingTxn;
      }
      throw err;
    }
  }

  // ----------- Cross-wallet transfer (gift send, etc.) -----------

  /**
   * Atomically deduct coins from sender and credit diamonds to receiver.
   * Uses a MongoDB transaction. Idempotent on `idempotencyKey`.
   */
  async transferGift(p: GiftTransferParams): Promise<{
    senderTxn: TransactionDocument;
    receiverTxn: TransactionDocument;
  }> {
    if (p.coinAmount <= 0 || p.diamondReward < 0) {
      throw new BadRequestException({ code: 'INVALID_AMOUNTS', message: 'Invalid amounts' });
    }
    // Self-gifting is allowed: caller is debited coins on the same
    // wallet and credited diamonds on the same wallet inside one
    // transaction. The two txn rows still record opposite directions,
    // which keeps the audit trail clean.

    const existing = await this.txnModel.find({ correlationId: p.idempotencyKey }).exec();
    if (existing.length === 2) {
      const sender = existing.find((t) => t.direction === TxnDirection.DEBIT)!;
      const receiver = existing.find((t) => t.direction === TxnDirection.CREDIT)!;
      return { senderTxn: sender, receiverTxn: receiver };
    }

    const session = await this.connection.startSession();
    try {
      let senderTxn!: TransactionDocument;
      let receiverTxn!: TransactionDocument;

      await session.withTransaction(async () => {
        const senderObj = new Types.ObjectId(p.senderUserId);
        const receiverObj = new Types.ObjectId(p.receiverUserId);

        const senderWallet = await this.walletModel.findOneAndUpdate(
          { userId: senderObj, frozen: false, coins: { $gte: p.coinAmount } },
          { $inc: { coins: -p.coinAmount, lifetimeCoinsSpent: p.coinAmount } },
          { new: true, session },
        );
        if (!senderWallet) {
          throw new BadRequestException({
            code: 'INSUFFICIENT_OR_FROZEN',
            message: 'Sender has insufficient coins or wallet is frozen',
          });
        }

        const receiverWallet = await this.walletModel.findOneAndUpdate(
          { userId: receiverObj, frozen: false },
          {
            $inc: { diamonds: p.diamondReward, lifetimeDiamondsEarned: p.diamondReward },
            $setOnInsert: { userId: receiverObj },
          },
          { new: true, upsert: true, session },
        );
        if (!receiverWallet) {
          throw new ForbiddenException({
            code: 'RECEIVER_WALLET_FROZEN',
            message: 'Receiver wallet is frozen',
          });
        }

        const senderKey = `${p.idempotencyKey}:debit`;
        const receiverKey = `${p.idempotencyKey}:credit`;

        const inserted = await this.txnModel.insertMany(
          [
            {
              idempotencyKey: senderKey,
              correlationId: p.idempotencyKey,
              walletId: senderWallet._id,
              userId: senderObj,
              currency: Currency.COINS,
              direction: TxnDirection.DEBIT,
              amount: p.coinAmount,
              type: TxnType.GIFT_SEND,
              description: p.description ?? 'Gift sent',
              refType: 'gift',
              refId: p.giftId && Types.ObjectId.isValid(p.giftId) ? new Types.ObjectId(p.giftId) : null,
              balanceAfter: senderWallet.coins,
              status: TxnStatus.COMPLETED,
            },
            {
              idempotencyKey: receiverKey,
              correlationId: p.idempotencyKey,
              walletId: receiverWallet._id,
              userId: receiverObj,
              currency: Currency.DIAMONDS,
              direction: TxnDirection.CREDIT,
              amount: p.diamondReward,
              type: TxnType.GIFT_RECEIVE,
              description: p.description ?? 'Gift received',
              refType: 'gift',
              refId: p.giftId && Types.ObjectId.isValid(p.giftId) ? new Types.ObjectId(p.giftId) : null,
              balanceAfter: receiverWallet.diamonds,
              status: TxnStatus.COMPLETED,
            },
          ],
          { session },
        );

        senderTxn = inserted[0] as TransactionDocument;
        receiverTxn = inserted[1] as TransactionDocument;
      });

      return { senderTxn, receiverTxn };
    } finally {
      await session.endSession();
    }
  }

  // ----------- Diamond → Coin conversion -----------

  /**
   * Atomically debit diamonds and credit coins on the same wallet doc.
   * Idempotent on the supplied key — same key returns the original txn
   * pair without doing anything else.
   *
   * Two ledger entries are written, one DEBIT + one CREDIT, both with
   * type=CONVERSION and the same correlationId so they can be reconciled
   * later. The wallet's coin/diamond counters update in a single
   * findOneAndUpdate so we can't partially apply one side.
   */
  async convertDiamondsToCoins(p: {
    userId: string;
    diamondsRequired: number;
    coinsAwarded: number;
    idempotencyKey: string;
  }): Promise<{
    wallet: WalletDocument;
    diamondTxn: TransactionDocument;
    coinTxn: TransactionDocument;
  }> {
    if (p.diamondsRequired <= 0 || p.coinsAwarded <= 0) {
      throw new BadRequestException({
        code: 'INVALID_AMOUNTS',
        message: 'Conversion amounts must be positive',
      });
    }
    if (!Types.ObjectId.isValid(p.userId)) {
      throw new BadRequestException({
        code: 'INVALID_USER_ID',
        message: 'Invalid user id',
      });
    }

    // Idempotency: re-running with the same key returns the original pair.
    const existing = await this.txnModel
      .find({ correlationId: p.idempotencyKey })
      .exec();
    if (existing.length === 2) {
      const wallet = await this.findByUserId(p.userId);
      if (!wallet) throw new NotFoundException('Wallet not found');
      const diamondTxn = existing.find((t) => t.currency === Currency.DIAMONDS)!;
      const coinTxn = existing.find((t) => t.currency === Currency.COINS)!;
      return { wallet, diamondTxn, coinTxn };
    }

    const userObj = new Types.ObjectId(p.userId);
    const updated = await this.walletModel
      .findOneAndUpdate(
        {
          userId: userObj,
          frozen: false,
          diamonds: { $gte: p.diamondsRequired },
        },
        {
          $inc: {
            diamonds: -p.diamondsRequired,
            coins: p.coinsAwarded,
          },
        },
        { new: true },
      )
      .exec();

    if (!updated) {
      const wallet = await this.findByUserId(p.userId);
      if (wallet?.frozen) {
        throw new ForbiddenException({
          code: 'WALLET_FROZEN',
          message: 'Wallet is frozen',
        });
      }
      throw new BadRequestException({
        code: 'INSUFFICIENT_DIAMONDS',
        message: 'Not enough diamonds for this conversion',
        details: {
          required: p.diamondsRequired,
          available: wallet?.diamonds ?? 0,
        },
      });
    }

    const diamondKey = `${p.idempotencyKey}:diamond`;
    const coinKey = `${p.idempotencyKey}:coin`;

    let diamondTxn!: TransactionDocument;
    let coinTxn!: TransactionDocument;
    try {
      const inserted = await this.txnModel.insertMany([
        {
          idempotencyKey: diamondKey,
          correlationId: p.idempotencyKey,
          walletId: updated._id,
          userId: userObj,
          currency: Currency.DIAMONDS,
          direction: TxnDirection.DEBIT,
          amount: p.diamondsRequired,
          type: TxnType.CONVERSION,
          description: `Diamonds → Coins`,
          balanceAfter: updated.diamonds,
          status: TxnStatus.COMPLETED,
        },
        {
          idempotencyKey: coinKey,
          correlationId: p.idempotencyKey,
          walletId: updated._id,
          userId: userObj,
          currency: Currency.COINS,
          direction: TxnDirection.CREDIT,
          amount: p.coinsAwarded,
          type: TxnType.CONVERSION,
          description: `Coins from diamond conversion`,
          balanceAfter: updated.coins,
          status: TxnStatus.COMPLETED,
        },
      ]);
      diamondTxn = inserted[0] as TransactionDocument;
      coinTxn = inserted[1] as TransactionDocument;
    } catch (err: any) {
      if (err?.code === 11000) {
        // Concurrent retry — the wallet was already debited/credited above
        // for this caller, but the ledger insert raced. Roll the wallet
        // back so we don't double-spend.
        await this.walletModel
          .updateOne(
            { _id: updated._id },
            {
              $inc: {
                diamonds: p.diamondsRequired,
                coins: -p.coinsAwarded,
              },
            },
          )
          .exec();
        const found = await this.txnModel
          .find({ correlationId: p.idempotencyKey })
          .exec();
        if (found.length === 2) {
          diamondTxn = found.find((t) => t.currency === Currency.DIAMONDS)!;
          coinTxn = found.find((t) => t.currency === Currency.COINS)!;
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }

    return { wallet: updated, diamondTxn, coinTxn };
  }

  // ----------- Admin freeze / unfreeze -----------

  async freeze(userId: string, reason: string, by: string): Promise<WalletDocument> {
    const wallet = await this.getOrCreate(userId);
    wallet.frozen = true;
    wallet.frozenReason = reason;
    wallet.frozenAt = new Date();
    wallet.frozenBy = Types.ObjectId.isValid(by) ? new Types.ObjectId(by) : null;
    await wallet.save();
    return wallet;
  }

  async unfreeze(userId: string): Promise<WalletDocument> {
    const wallet = await this.findByUserId(userId);
    if (!wallet) throw new NotFoundException('Wallet not found');
    wallet.frozen = false;
    wallet.frozenReason = '';
    wallet.frozenAt = null;
    wallet.frozenBy = null;
    await wallet.save();
    return wallet;
  }

  // ----------- Transactions -----------

  async listTransactions(params: ListTransactionsParams) {
    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(100, Math.max(1, params.limit ?? 50));
    const skip = (page - 1) * limit;

    const filter: FilterQuery<TransactionDocument> = {};
    if (params.userId && Types.ObjectId.isValid(params.userId)) {
      filter.userId = new Types.ObjectId(params.userId);
    }
    if (params.walletId && Types.ObjectId.isValid(params.walletId)) {
      filter.walletId = new Types.ObjectId(params.walletId);
    }
    if (params.currency) filter.currency = params.currency;
    if (params.type) filter.type = params.type;
    if (params.direction) filter.direction = params.direction;
    if (params.from || params.to) {
      filter.createdAt = {};
      if (params.from) (filter.createdAt as any).$gte = params.from;
      if (params.to) (filter.createdAt as any).$lte = params.to;
    }

    const [items, total] = await Promise.all([
      this.txnModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).exec(),
      this.txnModel.countDocuments(filter).exec(),
    ]);
    return { items, page, limit, total };
  }

  /** Generate a server-side idempotency key for actions that don't supply one. */
  generateKey(prefix: string): string {
    return `${prefix}:${nanoid(16)}`;
  }

  // ----------- helpers -----------

  private lifetimeFieldFor(
    currency: Currency,
    direction: TxnDirection,
    type: TxnType,
  ): string | null {
    if (currency === Currency.COINS && direction === TxnDirection.CREDIT) {
      if (
        type === TxnType.RECHARGE ||
        type === TxnType.RECHARGE_BONUS ||
        type === TxnType.MINT ||
        type === TxnType.RESELLER_TOPUP
      ) {
        // All "coins coming into the platform" channels increment this counter
        // (real recharge, admin mint, or reseller assignment).
        return 'lifetimeCoinsRecharged';
      }
    }
    if (currency === Currency.COINS && direction === TxnDirection.DEBIT) {
      if (type === TxnType.GIFT_SEND) return 'lifetimeCoinsSpent';
    }
    if (currency === Currency.DIAMONDS && direction === TxnDirection.CREDIT) {
      if (type === TxnType.GIFT_RECEIVE) return 'lifetimeDiamondsEarned';
    }
    if (currency === Currency.DIAMONDS && direction === TxnDirection.DEBIT) {
      if (type === TxnType.WITHDRAWAL) return 'lifetimeDiamondsWithdrawn';
    }
    return null;
  }

  /**
   * Map a (currency, direction, txn type) tuple to the honor
   * metric that should be re-evaluated after this transaction.
   * Mirrors `lifetimeFieldFor` — we re-evaluate exactly the
   * metrics whose lifetime counter just moved. Returns null when
   * the txn doesn't affect any rule-based honor.
   */
  private _honorMetricFor(
    currency: Currency,
    direction: TxnDirection,
    type: TxnType,
  ): HonorMetric | null {
    if (currency === Currency.COINS && direction === TxnDirection.CREDIT) {
      if (
        type === TxnType.RECHARGE ||
        type === TxnType.RECHARGE_BONUS ||
        type === TxnType.MINT ||
        type === TxnType.RESELLER_TOPUP
      ) {
        return HonorMetric.COINS_RECHARGED;
      }
    }
    if (currency === Currency.COINS && direction === TxnDirection.DEBIT) {
      if (type === TxnType.GIFT_SEND) return HonorMetric.COINS_SENT;
    }
    if (currency === Currency.DIAMONDS && direction === TxnDirection.CREDIT) {
      if (type === TxnType.GIFT_RECEIVE) return HonorMetric.DIAMONDS_RECEIVED;
    }
    return null;
  }
}
