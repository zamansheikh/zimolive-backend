import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

import { ChatPolicy, MicPolicy, RoomKind } from '../schemas/room.schema';

export class CreateRoomDto {
  /// Optional. When omitted, the service falls back to the user's
  /// displayName / username so first-time creators get a sensible default.
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  announcement?: string;

  @IsOptional()
  @IsEnum(RoomKind)
  kind?: RoomKind;

  /** Number of guest seats; owner seat is always present at index 0. */
  @IsOptional()
  @IsInt()
  @Min(4)
  @Max(15)
  micCount?: number;
}

export class UpdateRoomPoliciesDto {
  @IsOptional()
  @IsEnum(ChatPolicy)
  chat?: ChatPolicy;

  @IsOptional()
  @IsEnum(MicPolicy)
  mic?: MicPolicy;

  @IsOptional()
  @IsBoolean()
  superMic?: boolean;
}

export class UpdateRoomSettingsDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  announcement?: string;

  @IsOptional()
  @IsInt()
  @Min(4)
  @Max(15)
  micCount?: number;

  /**
   * Numeric room PIN. Exactly 4 digits when set; empty string clears it.
   * Omitting the field entirely leaves the password unchanged. Stored
   * both as a bcrypt hash (for compare on enter) and a `select: false`
   * plaintext mirror so the owner can re-view it from settings.
   */
  @IsOptional()
  @IsString()
  @Matches(/^(|\d{4})$/, {
    message: 'password must be a 4-digit PIN, or empty to clear',
  })
  password?: string;

  /** Room cover picture URL. Empty string clears it (falls back to the
   *  owner's avatar on the client). The cover-upload endpoint sets this
   *  to the Cloudinary URL after the image upload completes. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  coverUrl?: string;

  /** Cosmetic ID (must be a ROOM_CARD owned + equipped by the user). */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  themeCosmeticId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateRoomPoliciesDto)
  policies?: UpdateRoomPoliciesDto;
}

export class EnterRoomDto {
  /** Required if the room has a password. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  password?: string;
}

export class KickFromRoomDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

export class RemoveRoomDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

export class SendChatDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  text!: string;
}
