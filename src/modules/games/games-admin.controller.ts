import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';

import { AdminOnly } from '../admin/admin-auth/decorators/admin-only.decorator';
import { GamesService } from './games.service';

class GameItemDto {
  @IsString()
  key!: string;

  @IsString()
  label!: string;

  @IsNumber()
  @Min(1)
  multiplier!: number;
}

class UpdateGameConfigDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  iconUrl?: string;

  @IsOptional()
  @IsString()
  bannerUrl?: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsInt()
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => GameItemDto)
  items?: GameItemDto[];

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsInt({ each: true })
  @Min(1, { each: true })
  betTiers?: number[];

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  rtpPercent?: number;

  @IsOptional()
  @IsIn(['coins', 'diamonds'])
  currency?: 'coins' | 'diamonds';

  @IsOptional()
  @IsInt()
  @Min(5_000)
  @Max(5 * 60 * 1000)
  bettingMs?: number;

  @IsOptional()
  @IsInt()
  @Min(1_000)
  @Max(30 * 1000)
  spinMs?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(60 * 1000)
  intermissionMs?: number;
}

/** Create-game DTO. Reuses the update validators but flips the
 *  base fields to required. `kind` is open for future engines but
 *  defaults to `wheel_betting` on the server when omitted. */
class CreateGameConfigDto {
  @IsString()
  @Matches(/^[a-z][a-z0-9_]{1,31}$/, {
    message:
      'gameKey must be lowercase letters / digits / underscores (start with a letter, 2-32 chars)',
  })
  gameKey!: string;

  @IsOptional()
  @IsIn(['wheel_betting'])
  kind?: 'wheel_betting';

  @IsString()
  title!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  iconUrl?: string;

  @IsOptional()
  @IsString()
  bannerUrl?: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsInt()
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => GameItemDto)
  items!: GameItemDto[];

  @IsArray()
  @ArrayMinSize(1)
  @IsInt({ each: true })
  @Min(1, { each: true })
  betTiers!: number[];

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  rtpPercent?: number;

  @IsOptional()
  @IsIn(['coins', 'diamonds'])
  currency?: 'coins' | 'diamonds';

  @IsOptional()
  @IsInt()
  @Min(5_000)
  @Max(5 * 60 * 1000)
  bettingMs?: number;

  @IsOptional()
  @IsInt()
  @Min(1_000)
  @Max(30 * 1000)
  spinMs?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(60 * 1000)
  intermissionMs?: number;
}

/**
 * Admin moderation of wheel-betting games. Read-only listing +
 * config edits — the round runner itself is autonomous, so the
 * admin doesn't need a "start round" button. Disabling a game
 * via `enabled: false` lets the current round finish then pauses
 * the loop; flipping it back to `true` resumes immediately.
 */
@Controller({ path: 'admin/games', version: '1' })
@AdminOnly()
export class GamesAdminController {
  constructor(private readonly svc: GamesService) {}

  @Get()
  async list() {
    // Admin sees every game, including paused ones.
    const games = await this.svc.listAllGames();
    return { games };
  }

  @Post()
  async create(@Body() dto: CreateGameConfigDto) {
    const config = await this.svc.createGame(dto);
    return { config };
  }

  @Get(':gameKey/config')
  async config(@Param('gameKey') gameKey: string) {
    const config = await this.svc.getConfig(gameKey);
    return { config };
  }

  @Patch(':gameKey/config')
  async update(
    @Param('gameKey') gameKey: string,
    @Body() dto: UpdateGameConfigDto,
  ) {
    const config = await this.svc.updateConfig(gameKey, dto as any);
    return { config };
  }

  @Delete(':gameKey')
  async remove(@Param('gameKey') gameKey: string) {
    return this.svc.deleteGame(gameKey);
  }

  @Get(':gameKey/history')
  async history(@Param('gameKey') gameKey: string) {
    const rounds = await this.svc.listHistory(gameKey, 50);
    return { rounds };
  }

  /**
   * Brute-force reset for a wedged game: closes every non-completed
   * round, cancels any pending transition, and opens a fresh round.
   * Last-resort escape hatch for when the per-call heal can't recover.
   */
  @Post(':gameKey/reset')
  async reset(@Param('gameKey') gameKey: string) {
    const round = await this.svc.resetRounds(gameKey);
    return { round };
  }
}
