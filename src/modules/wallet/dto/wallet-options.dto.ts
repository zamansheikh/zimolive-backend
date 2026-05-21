import {
  IsBoolean,
  IsDateString,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateRechargePackageDto {
  @IsInt()
  @Min(1)
  coins!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  bonusCoins?: number;

  @IsInt()
  @Min(0)
  priceAmount!: number;

  @IsOptional()
  @IsString()
  @Length(2, 6)
  priceCurrency?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  badgeText?: string;

  @IsOptional()
  @IsInt()
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  /** Google Play / App Store in-app product ids the purchase maps back to. */
  @IsOptional()
  @IsString()
  @MaxLength(160)
  googleProductId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  appleProductId?: string;

  /** Mark as a limited-time special offer (own highlighted strip in-app). */
  @IsOptional()
  @IsBoolean()
  isOffer?: boolean;

  /** "Was" price for the struck-through original (0 = none). */
  @IsOptional()
  @IsInt()
  @Min(0)
  originalPriceAmount?: number;
}

export class UpdateRechargePackageDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  coins?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  bonusCoins?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  priceAmount?: number;

  @IsOptional()
  @IsString()
  @Length(2, 6)
  priceCurrency?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  badgeText?: string;

  @IsOptional()
  @IsInt()
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  googleProductId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  appleProductId?: string;

  @IsOptional()
  @IsBoolean()
  isOffer?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  originalPriceAmount?: number;
}

export class CreateExchangeOptionDto {
  @IsInt()
  @Min(1)
  diamondsRequired!: number;

  @IsInt()
  @Min(1)
  coinsAwarded!: number;

  @IsOptional()
  @IsInt()
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdateExchangeOptionDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  diamondsRequired?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  coinsAwarded?: number;

  @IsOptional()
  @IsInt()
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class ExchangeDiamondsDto {
  @IsMongoId()
  optionId!: string;

  @IsString()
  @MaxLength(80)
  idempotencyKey!: string;
}
