import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { User, UserDocument } from '../users/schemas/user.schema';
import {
  UserSvipStatus,
  UserSvipStatusDocument,
} from '../svip/schemas/user-svip-status.schema';
import { Wallet, WalletDocument } from '../wallet/schemas/wallet.schema';
import { HonorMetric } from './schemas/honor-item.schema';

/**
 * Single source of truth for "what's the user's current value for
 * metric X?". Backed by data that's already denormalized elsewhere:
 *
 *   • User    — level, xp, followersCount, followingCount.
 *   • Wallet  — lifetimeCoinsRecharged, lifetimeCoinsSpent,
 *               lifetimeDiamondsEarned (already $inc'd on every
 *               relevant transaction).
 *   • UserSvipStatus — currentLevel.
 *
 * No new collection / counter is needed; this just unifies the
 * read paths. The honor evaluator calls `getValue` against the
 * metric on each tier and grants the highest qualifying tier.
 */
@Injectable()
export class HonorMetricsService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Wallet.name)
    private readonly walletModel: Model<WalletDocument>,
    @InjectModel(UserSvipStatus.name)
    private readonly svipStatusModel: Model<UserSvipStatusDocument>,
  ) {}

  /**
   * Look up the user's current value of `metric`. Returns 0 for
   * unknown metrics, missing documents, or the `NONE` sentinel.
   * Always non-negative.
   */
  async getValue(userId: string, metric: HonorMetric): Promise<number> {
    if (metric === HonorMetric.NONE) return 0;
    if (!Types.ObjectId.isValid(userId)) return 0;
    const userOid = new Types.ObjectId(userId);

    switch (metric) {
      case HonorMetric.LEVEL:
      case HonorMetric.XP:
      case HonorMetric.FOLLOWERS:
      case HonorMetric.FOLLOWING: {
        const user = await this.userModel
          .findById(userOid)
          .select('level xp followersCount followingCount')
          .lean()
          .exec();
        if (!user) return 0;
        if (metric === HonorMetric.LEVEL) return user.level ?? 0;
        if (metric === HonorMetric.XP) return user.xp ?? 0;
        if (metric === HonorMetric.FOLLOWERS) return user.followersCount ?? 0;
        return user.followingCount ?? 0;
      }
      case HonorMetric.COINS_RECHARGED:
      case HonorMetric.COINS_SENT:
      case HonorMetric.DIAMONDS_RECEIVED: {
        const wallet = await this.walletModel
          .findOne({ userId: userOid })
          .select(
            'lifetimeCoinsRecharged lifetimeCoinsSpent lifetimeDiamondsEarned',
          )
          .lean()
          .exec();
        if (!wallet) return 0;
        if (metric === HonorMetric.COINS_RECHARGED) {
          return wallet.lifetimeCoinsRecharged ?? 0;
        }
        if (metric === HonorMetric.COINS_SENT) {
          return wallet.lifetimeCoinsSpent ?? 0;
        }
        return wallet.lifetimeDiamondsEarned ?? 0;
      }
      case HonorMetric.SVIP_TIER: {
        const status = await this.svipStatusModel
          .findOne({ userId: userOid })
          .select('currentLevel')
          .lean()
          .exec();
        return status?.currentLevel ?? 0;
      }
      default:
        return 0;
    }
  }
}
