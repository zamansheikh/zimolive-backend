import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import {
  HonorAssetType,
  HonorCategory,
  HonorMetric,
} from '../schemas/honor-item.schema';

/** Per-tier definition payload — see HonorItem.tiers in the schema. */
export class HonorTierDto {
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  name!: string;

  @IsOptional()
  @IsString()
  iconUrl?: string;

  @IsOptional()
  @IsString()
  svgaUrl?: string;

  @IsOptional()
  @IsEnum(HonorMetric)
  metric?: HonorMetric;

  @IsOptional()
  @IsNumber()
  @Min(0)
  target?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  rewardText?: string;
}

export class CreateHonorItemDto {
  @IsString()
  @MinLength(2)
  @MaxLength(40)
  @Matches(/^[a-z0-9_]+$/, {
    message: 'key must be lowercase alphanumeric / underscore',
  })
  key!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @IsOptional()
  @IsEnum(HonorCategory)
  category?: HonorCategory;

  @IsOptional()
  @IsString()
  iconUrl?: string;

  @IsOptional()
  @IsString()
  iconPublicId?: string;

  @IsOptional()
  @IsString()
  svgaUrl?: string;

  @IsOptional()
  @IsString()
  svgaPublicId?: string;

  @IsOptional()
  @IsEnum(HonorAssetType)
  iconAssetType?: HonorAssetType;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  maxTier?: number;

  @IsOptional()
  @IsNumber()
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => HonorTierDto)
  tiers?: HonorTierDto[];
}

export class UpdateHonorItemDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @IsOptional()
  @IsEnum(HonorCategory)
  category?: HonorCategory;

  @IsOptional()
  @IsString()
  iconUrl?: string;

  @IsOptional()
  @IsString()
  iconPublicId?: string;

  @IsOptional()
  @IsString()
  svgaUrl?: string;

  @IsOptional()
  @IsString()
  svgaPublicId?: string;

  @IsOptional()
  @IsEnum(HonorAssetType)
  iconAssetType?: HonorAssetType;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  maxTier?: number;

  @IsOptional()
  @IsNumber()
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => HonorTierDto)
  tiers?: HonorTierDto[];
}

export class WearHonorDto {
  /** 0..9. Service rejects any other value. */
  @IsInt()
  @Min(0)
  @Max(9)
  slot!: number;
}

export class GrantHonorDto {
  /** Either the catalog row id (Mongo _id) or its stable `key`. The
   *  service resolves either form so admins can paste a key from
   *  the catalog without copying ids. */
  @IsString()
  @MinLength(1)
  honorRef!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  tier?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}
