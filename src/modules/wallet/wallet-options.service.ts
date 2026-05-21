import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';

import {
  ExchangeOption,
  ExchangeOptionDocument,
} from './schemas/exchange-option.schema';
import {
  RechargePackage,
  RechargePackageDocument,
} from './schemas/recharge-package.schema';

/**
 * CRUD + listing for the two admin-configurable lists shown on the user
 * wallet:
 *
 *   • RechargePackages — "60 000 coins for 12 BDT"
 *   • ExchangeOptions  — "1 000 diamonds → 330 coins"
 *
 * Lives separately from WalletService because these are pure metadata
 * tables — no money moves through here. Conversions go through
 * WalletService.convertDiamondsToCoins which holds the atomicity contract.
 */
@Injectable()
export class WalletOptionsService {
  constructor(
    @InjectModel(RechargePackage.name)
    private readonly packageModel: Model<RechargePackageDocument>,
    @InjectModel(ExchangeOption.name)
    private readonly exchangeModel: Model<ExchangeOptionDocument>,
  ) {}

  // ============== Recharge packages ==============

  async listActivePackages(): Promise<RechargePackageDocument[]> {
    const now = new Date();
    return this.packageModel
      .find({
        active: true,
        $and: [
          { $or: [{ startDate: null }, { startDate: { $lte: now } }] },
          { $or: [{ endDate: null }, { endDate: { $gte: now } }] },
        ],
      })
      .sort({ sortOrder: -1, priceAmount: 1 })
      .exec();
  }

  async listAdminPackages(params: { page?: number; limit?: number; active?: boolean }) {
    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(100, Math.max(1, params.limit ?? 50));
    const skip = (page - 1) * limit;
    const filter: FilterQuery<RechargePackageDocument> = {};
    if (params.active !== undefined) filter.active = params.active;

    const [items, total] = await Promise.all([
      this.packageModel
        .find(filter)
        .sort({ sortOrder: -1, priceAmount: 1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      this.packageModel.countDocuments(filter).exec(),
    ]);
    return { items, page, limit, total };
  }

  async findPackage(id: string): Promise<RechargePackageDocument | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return this.packageModel.findById(id).exec();
  }

  async getPackageOrThrow(id: string): Promise<RechargePackageDocument> {
    const p = await this.findPackage(id);
    if (!p) throw new NotFoundException('Recharge package not found');
    return p;
  }

  async createPackage(input: any, createdBy?: string): Promise<RechargePackageDocument> {
    return this.packageModel.create({
      ...input,
      priceCurrency: (input.priceCurrency ?? 'BDT').toUpperCase(),
      startDate: input.startDate ? new Date(input.startDate) : null,
      endDate: input.endDate ? new Date(input.endDate) : null,
      createdBy:
        createdBy && Types.ObjectId.isValid(createdBy)
          ? new Types.ObjectId(createdBy)
          : null,
    });
  }

  async updatePackage(id: string, update: any): Promise<RechargePackageDocument> {
    const p = await this.getPackageOrThrow(id);
    if (update.coins !== undefined) p.coins = update.coins;
    if (update.bonusCoins !== undefined) p.bonusCoins = update.bonusCoins;
    if (update.priceAmount !== undefined) p.priceAmount = update.priceAmount;
    if (update.priceCurrency !== undefined)
      p.priceCurrency = update.priceCurrency.toUpperCase();
    if (update.badgeText !== undefined) p.badgeText = update.badgeText;
    if (update.sortOrder !== undefined) p.sortOrder = update.sortOrder;
    if (update.active !== undefined) p.active = update.active;
    if (update.googleProductId !== undefined)
      p.googleProductId = update.googleProductId;
    if (update.appleProductId !== undefined)
      p.appleProductId = update.appleProductId;
    if (update.isOffer !== undefined) p.isOffer = update.isOffer;
    if (update.originalPriceAmount !== undefined)
      p.originalPriceAmount = update.originalPriceAmount;
    if (update.startDate !== undefined)
      p.startDate = update.startDate ? new Date(update.startDate) : null;
    if (update.endDate !== undefined)
      p.endDate = update.endDate ? new Date(update.endDate) : null;
    await p.save();
    return p;
  }

  async deletePackage(id: string): Promise<void> {
    const p = await this.getPackageOrThrow(id);
    await this.packageModel.deleteOne({ _id: p._id }).exec();
  }

  // ============== Exchange options ==============

  async listActiveExchangeOptions(): Promise<ExchangeOptionDocument[]> {
    return this.exchangeModel
      .find({ active: true })
      .sort({ sortOrder: 1, diamondsRequired: 1 })
      .exec();
  }

  async listAdminExchangeOptions(params: { page?: number; limit?: number; active?: boolean }) {
    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(100, Math.max(1, params.limit ?? 50));
    const skip = (page - 1) * limit;
    const filter: FilterQuery<ExchangeOptionDocument> = {};
    if (params.active !== undefined) filter.active = params.active;

    const [items, total] = await Promise.all([
      this.exchangeModel
        .find(filter)
        .sort({ sortOrder: 1, diamondsRequired: 1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      this.exchangeModel.countDocuments(filter).exec(),
    ]);
    return { items, page, limit, total };
  }

  async findExchangeOption(id: string): Promise<ExchangeOptionDocument | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return this.exchangeModel.findById(id).exec();
  }

  async getExchangeOptionOrThrow(id: string): Promise<ExchangeOptionDocument> {
    const o = await this.findExchangeOption(id);
    if (!o) throw new NotFoundException('Exchange option not found');
    return o;
  }

  async createExchangeOption(input: any, createdBy?: string): Promise<ExchangeOptionDocument> {
    const exists = await this.exchangeModel
      .countDocuments({ diamondsRequired: input.diamondsRequired })
      .exec();
    if (exists) {
      throw new ConflictException({
        code: 'EXCHANGE_TIER_TAKEN',
        message: `An exchange option for ${input.diamondsRequired} diamonds already exists`,
      });
    }
    return this.exchangeModel.create({
      ...input,
      createdBy:
        createdBy && Types.ObjectId.isValid(createdBy)
          ? new Types.ObjectId(createdBy)
          : null,
    });
  }

  async updateExchangeOption(id: string, update: any): Promise<ExchangeOptionDocument> {
    const o = await this.getExchangeOptionOrThrow(id);
    if (update.diamondsRequired !== undefined && update.diamondsRequired !== o.diamondsRequired) {
      const dup = await this.exchangeModel
        .countDocuments({
          diamondsRequired: update.diamondsRequired,
          _id: { $ne: o._id },
        })
        .exec();
      if (dup) {
        throw new ConflictException({
          code: 'EXCHANGE_TIER_TAKEN',
          message: 'Another option already covers that diamond amount',
        });
      }
      o.diamondsRequired = update.diamondsRequired;
    }
    if (update.coinsAwarded !== undefined) o.coinsAwarded = update.coinsAwarded;
    if (update.sortOrder !== undefined) o.sortOrder = update.sortOrder;
    if (update.active !== undefined) o.active = update.active;
    await o.save();
    return o;
  }

  async deleteExchangeOption(id: string): Promise<void> {
    const o = await this.getExchangeOptionOrThrow(id);
    await this.exchangeModel.deleteOne({ _id: o._id }).exec();
  }
}
