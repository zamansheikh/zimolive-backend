import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { RoomEmojiType } from '../schemas/room-emoji.schema';

export class CreateRoomEmojiDto {
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  category?: string;

  @IsEnum(RoomEmojiType)
  type!: RoomEmojiType;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  assetUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  assetPublicId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  char?: string;

  @IsOptional()
  @IsInt()
  @Min(500)
  @Max(15000)
  durationMs?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

export class UpdateRoomEmojiDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  category?: string;

  @IsOptional()
  @IsEnum(RoomEmojiType)
  type?: RoomEmojiType;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  assetUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  assetPublicId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  char?: string;

  @IsOptional()
  @IsInt()
  @Min(500)
  @Max(15000)
  durationMs?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

export class SendEmojiDto {
  @IsString()
  emojiId!: string;
}
