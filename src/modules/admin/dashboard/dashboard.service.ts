import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { Agency, AgencyDocument } from '../../agencies/schemas/agency.schema';
import { Family, FamilyDocument } from '../../families/schemas/family.schema';
import {
  GameBet,
  GameBetDocument,
} from '../../games/schemas/game-bet.schema';
import {
  Reseller,
  ResellerDocument,
} from '../../resellers/schemas/reseller.schema';
import { Room, RoomDocument } from '../../rooms/schemas/room.schema';
import { User, UserDocument } from '../../users/schemas/user.schema';
import {
  Transaction,
  TransactionDocument,
} from '../../wallet/schemas/transaction.schema';
import { Wallet, WalletDocument } from '../../wallet/schemas/wallet.schema';

const TZ = 'Asia/Dhaka';
const DAY_MS = 24 * 60 * 60 * 1000;

interface DayPoint {
  date: string;
  [k: string]: number | string;
}

/**
 * Read-only analytics for the admin dashboard overview. Each metric is a
 * cheap count / sum / daily-bucket aggregation; the whole thing runs in
 * parallel and is meant to be polled on the landing page, not on a hot path.
 */
@Injectable()
export class DashboardService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Wallet.name)
    private readonly walletModel: Model<WalletDocument>,
    @InjectModel(Transaction.name)
    private readonly txnModel: Model<TransactionDocument>,
    @InjectModel(Room.name) private readonly roomModel: Model<RoomDocument>,
    @InjectModel(Agency.name)
    private readonly agencyModel: Model<AgencyDocument>,
    @InjectModel(Reseller.name)
    private readonly resellerModel: Model<ResellerDocument>,
    @InjectModel(Family.name)
    private readonly familyModel: Model<FamilyDocument>,
    @InjectModel(GameBet.name)
    private readonly betModel: Model<GameBetDocument>,
  ) {}

  async overview(): Promise<unknown> {
    const now = Date.now();
    const since7 = new Date(now - 7 * DAY_MS);
    const since30 = new Date(now - 30 * DAY_MS);

    const [
      totalUsers,
      newUsers7d,
      newUsers30d,
      totalRooms,
      activeRooms,
      agencies,
      resellers,
      families,
      walletAgg,
      newUsersDaily,
      rechargeDaily,
      giftDaily,
      gameDaily,
      usersByCountry,
      coinFlow,
    ] = await Promise.all([
      this.userModel.estimatedDocumentCount().exec(),
      this.userModel.countDocuments({ createdAt: { $gte: since7 } }).exec(),
      this.userModel.countDocuments({ createdAt: { $gte: since30 } }).exec(),
      this.roomModel.estimatedDocumentCount().exec(),
      this.roomModel.countDocuments({ status: 'active' }).exec(),
      this.agencyModel.estimatedDocumentCount().exec(),
      this.resellerModel.estimatedDocumentCount().exec(),
      this.familyModel.estimatedDocumentCount().exec(),
      this.walletModel
        .aggregate([
          {
            $group: {
              _id: null,
              coins: { $sum: '$coins' },
              diamonds: { $sum: '$diamonds' },
            },
          },
        ])
        .exec(),
      // New users per day (last 30d).
      this.userModel
        .aggregate([
          { $match: { createdAt: { $gte: since30 } } },
          {
            $group: {
              _id: this.dayKey('$createdAt'),
              count: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
        ])
        .exec(),
      // Coins purchased per day (recharge credits).
      this.txnModel
        .aggregate([
          {
            $match: {
              type: 'recharge',
              currency: 'coins',
              createdAt: { $gte: since30 },
            },
          },
          {
            $group: {
              _id: this.dayKey('$createdAt'),
              coins: { $sum: '$amount' },
            },
          },
          { $sort: { _id: 1 } },
        ])
        .exec(),
      // Coins spent on gifts per day.
      this.txnModel
        .aggregate([
          {
            $match: {
              type: 'gift_send',
              currency: 'coins',
              createdAt: { $gte: since30 },
            },
          },
          {
            $group: {
              _id: this.dayKey('$createdAt'),
              coins: { $sum: '$amount' },
            },
          },
          { $sort: { _id: 1 } },
        ])
        .exec(),
      // Game economy per day (wagered / won / admin profit). 30d window
      // matches the bet-history retention.
      this.betModel
        .aggregate([
          { $match: { createdAt: { $gte: since30 } } },
          {
            $group: {
              _id: this.dayKey('$createdAt'),
              wagered: { $sum: '$amount' },
              won: { $sum: '$payoutAmount' },
            },
          },
          {
            $project: {
              wagered: 1,
              won: 1,
              profit: { $subtract: ['$wagered', '$won'] },
            },
          },
          { $sort: { _id: 1 } },
        ])
        .exec(),
      // Top countries by user count.
      this.userModel
        .aggregate([
          { $match: { country: { $nin: [null, ''] } } },
          { $group: { _id: '$country', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 8 },
        ])
        .exec(),
      // Coin flow by transaction type (last 30d) — where coins come from
      // and go to.
      this.txnModel
        .aggregate([
          { $match: { currency: 'coins', createdAt: { $gte: since30 } } },
          { $group: { _id: '$type', total: { $sum: '$amount' } } },
          { $sort: { total: -1 } },
        ])
        .exec(),
    ]);

    const wallet = (walletAgg[0] as { coins?: number; diamonds?: number }) ?? {};

    return {
      totals: {
        users: totalUsers,
        newUsers7d,
        newUsers30d,
        rooms: totalRooms,
        activeRooms,
        agencies,
        resellers,
        families,
        coinsInCirculation: wallet.coins ?? 0,
        diamondsInCirculation: wallet.diamonds ?? 0,
      },
      series: {
        newUsersDaily: this.fill(newUsersDaily, since30, ['count']),
        rechargeDaily: this.fill(rechargeDaily, since30, ['coins']),
        giftDaily: this.fill(giftDaily, since30, ['coins']),
        gameDaily: this.fill(gameDaily, since30, ['wagered', 'won', 'profit']),
      },
      breakdowns: {
        usersByCountry: (usersByCountry as Array<{ _id: string; count: number }>).map(
          (r) => ({ country: r._id, count: r.count }),
        ),
        coinFlowByType: (coinFlow as Array<{ _id: string; total: number }>).map(
          (r) => ({ type: r._id, total: r.total }),
        ),
      },
    };
  }

  /** `$dateToString` day bucket in the configured timezone. */
  private dayKey(field: string) {
    return {
      $dateToString: { format: '%Y-%m-%d', date: field, timezone: TZ },
    };
  }

  /**
   * Turn a sparse `[{ _id: 'YYYY-MM-DD', ...}]` aggregation into a dense
   * day-by-day series from `since` to today, zero-filling missing days so
   * the chart x-axis is continuous.
   */
  private fill(
    rows: Array<Record<string, unknown>>,
    since: Date,
    keys: string[],
  ): DayPoint[] {
    const byDate = new Map<string, Record<string, unknown>>();
    for (const r of rows) byDate.set(String(r._id), r);

    const out: DayPoint[] = [];
    const cursor = new Date(since);
    const today = new Date();
    while (cursor <= today) {
      const date = this.localDayKey(cursor);
      const row = byDate.get(date);
      const point: DayPoint = { date };
      for (const k of keys) {
        point[k] = (row?.[k] as number | undefined) ?? 0;
      }
      out.push(point);
      cursor.setTime(cursor.getTime() + DAY_MS);
    }
    return out;
  }

  /** yyyy-MM-dd for a Date in the configured timezone (Asia/Dhaka). */
  private localDayKey(d: Date): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  }
}
