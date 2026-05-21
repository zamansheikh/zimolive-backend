import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

class RocketLevelDto {
  @IsInt()
  @Min(1)
  level!: number;

  @IsInt()
  @Min(1)
  energyRequired!: number;

  @IsInt()
  @Min(0)
  top1Coins!: number;

  @IsInt()
  @Min(0)
  top2Coins!: number;

  @IsInt()
  @Min(0)
  top3Coins!: number;

  @IsInt()
  @Min(0)
  randomPoolCoins!: number;

  @IsInt()
  @Min(0)
  @Max(100)
  randomBeneficiaries!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  assetUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  iconUrl?: string;
}

export class UpdateRocketConfigDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  topContributionThreshold?: number;

  @IsOptional()
  @IsInt()
  @Min(3)
  @Max(60)
  bannerSeconds?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(120)
  launchCountdownSeconds?: number;

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(300)
  cascadeDelaySeconds?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RocketLevelDto)
  levels?: RocketLevelDto[];
}
