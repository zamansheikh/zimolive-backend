import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { IsInt, IsString, Min } from 'class-validator';

import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { GamesService } from './games.service';

class PlaceBetDto {
  @IsString()
  item!: string;

  @IsInt()
  @Min(1)
  amount!: number;
}

/**
 * Endpoints behind the wheel-betting web games (Fruits Loop, etc.).
 *
 *   • `GET /games` — list of enabled games (web app uses this for
 *     the lobby / picker).
 *   • `GET /games/:gameKey/config` — items + multipliers + bet
 *     tiers. Public — the web app reads it before showing the
 *     wheel even to a not-yet-signed-in browser.
 *   • `GET /games/:gameKey/current` — the active round. Used for
 *     bootstrap; subsequent updates flow over the realtime
 *     `game:<gameKey>` scope.
 *   • `GET /games/:gameKey/history` — last N completed rounds.
 *   • `POST /games/:gameKey/bet` — place a bet (auth required).
 *   • `GET /games/:gameKey/me/bets` — caller's recent bets.
 */
/**
 * `@SkipThrottle` on read endpoints — the game UI polls
 * `/current` every 2s and refreshes `/history` + per-user bets
 * on every round transition. Hitting the global 100/60s limit
 * with normal play wedges the page. These reads are cheap
 * (single indexed find), public, and idempotent, so blanket
 * skipping is safer than tuning per-endpoint quotas.
 *
 * The mutate endpoint (`POST /bet`) keeps the default throttle —
 * a runaway bet loop would actually drain wallets.
 */
@Controller({ path: 'games', version: '1' })
@SkipThrottle()
export class GamesController {
  constructor(private readonly svc: GamesService) {}

  @Public()
  @Get()
  async list() {
    const games = await this.svc.listGames();
    return { games };
  }

  @Public()
  @Get(':gameKey/config')
  async config(@Param('gameKey') gameKey: string) {
    const config = await this.svc.getConfig(gameKey);
    return { config };
  }

  /** Live round state. Marked no-cache because the round phase
   *  changes every few seconds — a stale cached copy in any
   *  intermediate (WebView HTTP cache, CDN, browser disk
   *  cache) leaves the client showing the wrong phase or a
   *  countdown that's hours out of date. */
  @Public()
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  @Get(':gameKey/current')
  async current(@Param('gameKey') gameKey: string) {
    const round = await this.svc.getCurrentRound(gameKey);
    return { round };
  }

  @Public()
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
  @Get(':gameKey/history')
  async history(
    @Param('gameKey') gameKey: string,
    @Query('limit') limit?: string,
  ) {
    const n = Number.parseInt(limit ?? '20', 10) || 20;
    const rounds = await this.svc.listHistory(gameKey, n);
    return { rounds };
  }

  /** Bet placement — keeps a throttle (60 bets / minute per IP)
   *  so a runaway client loop can't drain a wallet. 60/min is
   *  generous: a manual tapper at 1 bet per second hits 60 in a
   *  minute, more than that is almost certainly a stuck script. */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @UseGuards(JwtAuthGuard)
  @Post(':gameKey/bet')
  async placeBet(
    @CurrentUser() current: AuthenticatedUser,
    @Param('gameKey') gameKey: string,
    @Body() dto: PlaceBetDto,
  ) {
    const { round, bet } = await this.svc.placeBet({
      userId: current.userId,
      gameKey,
      item: dto.item,
      amount: dto.amount,
    });
    return { round, bet };
  }

  @UseGuards(JwtAuthGuard)
  @Get(':gameKey/me/bets')
  async myBets(
    @CurrentUser() current: AuthenticatedUser,
    @Param('gameKey') gameKey: string,
    @Query('limit') limit?: string,
  ) {
    const n = Number.parseInt(limit ?? '20', 10) || 20;
    const bets = await this.svc.listMyBets(current.userId, gameKey, n);
    return { bets };
  }
}
