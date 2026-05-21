import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type RechargePackageDocument = HydratedDocument<RechargePackage>;

/**
 * A purchasable bundle on the wallet recharge screen — e.g. "60,000 coins
 * for 12 BDT". Pure metadata; the actual payment flow (gateway → wallet
 * credit) is wired separately. The mobile app reads these to render the
 * recharge grid; the admin panel CRUDs them.
 */
@Schema({
  collection: 'recharge_packages',
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
export class RechargePackage {
  /** Base coin amount delivered. */
  @Prop({ type: Number, required: true, min: 1 })
  coins!: number;

  /** Bonus coins on top of the base — surfaced as "+180000" in the UI. */
  @Prop({ type: Number, default: 0, min: 0 })
  bonusCoins!: number;

  /** Numeric price in the configured currency (e.g. 12, 120, 650). */
  @Prop({ type: Number, required: true, min: 0 })
  priceAmount!: number;

  /** ISO-4217-ish currency code displayed alongside the price. */
  @Prop({ type: String, default: 'BDT', uppercase: true, trim: true })
  priceCurrency!: string;

  /** Optional small badge (emoji, "🎁" / "HOT" etc.) shown on the tile. */
  @Prop({ type: String, default: '' })
  badgeText!: string;

  /**
   * Marks a LIMITED-TIME special offer (e.g. "huge coins, very cheap").
   * Offer packages are surfaced in their own highlighted strip at the top
   * of the wallet, separate from the standard recharge grid, and are
   * usually time-boxed via `startDate`/`endDate`. Default false = ordinary
   * always-on package.
   */
  @Prop({ type: Boolean, default: false, index: true })
  isOffer!: boolean;

  /**
   * "Was" price for an offer, used to render a struck-through original
   * price next to the discounted `priceAmount` (e.g. ~~650~~ 65). 0 = no
   * comparison shown. Same currency as `priceAmount`.
   */
  @Prop({ type: Number, default: 0, min: 0 })
  originalPriceAmount!: number;

  /**
   * Google Play in-app product id (the one set up in Play Console
   * Monetization → Products → In-app products). RevenueCat is the SDK
   * we use to drive billing, but the *product* still lives in the
   * store; RevenueCat just routes purchase events back to our webhook
   * with this id in the payload.
   *
   * Sparse so legacy packages without IDs don't trigger duplicate-key
   * errors. Indexed for the webhook hot path: every purchase webhook
   * does a single lookup by this field to map to a RechargePackage.
   */
  @Prop({ type: String, default: '', sparse: true, index: true })
  googleProductId!: string;

  /**
   * App Store Connect in-app product id (Apple equivalent of the
   * Google one above). Same flow — RC ships the id on the webhook,
   * we resolve it to a RechargePackage and credit the wallet.
   */
  @Prop({ type: String, default: '', sparse: true, index: true })
  appleProductId!: string;

  @Prop({ type: Number, default: 0, index: true })
  sortOrder!: number;

  @Prop({ type: Boolean, default: true, index: true })
  active!: boolean;

  @Prop({ type: Date, default: null })
  startDate?: Date | null;

  @Prop({ type: Date, default: null })
  endDate?: Date | null;

  @Prop({ type: Types.ObjectId, ref: 'AdminUser', default: null })
  createdBy?: Types.ObjectId | null;
}

export const RechargePackageSchema =
  SchemaFactory.createForClass(RechargePackage);
RechargePackageSchema.index({ active: 1, sortOrder: -1, priceAmount: 1 });
