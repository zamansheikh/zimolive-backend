import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { RealtimeModule } from '../realtime/realtime.module';
import { User, UserSchema } from '../users/schemas/user.schema';
import { WalletModule } from '../wallet/wallet.module';
import { GamesAdminController } from './games-admin.controller';
import { GamesController } from './games.controller';
import { GamesService } from './games.service';
import { GameBet, GameBetSchema } from './schemas/game-bet.schema';
import {
  GameConfig,
  GameConfigSchema,
} from './schemas/game-config.schema';
import {
  GameRound,
  GameRoundSchema,
} from './schemas/game-round.schema';

/**
 * Wheel-betting games module (Fruits Loop, future Greedy Baby
 * clones, etc.). Self-contained — the round runner schedules its
 * own transitions in-process via setTimeout, so there's no
 * external scheduler dependency.
 *
 * The actual game UIs (HTML/JS) live OUTSIDE this repo in
 * `zimolive-games/` and are served as static files; the backend
 * only handles authority (round state, bet validation, wallet
 * debit/credit, RTP-bounded result selection).
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: GameConfig.name, schema: GameConfigSchema },
      { name: GameRound.name, schema: GameRoundSchema },
      { name: GameBet.name, schema: GameBetSchema },
      // Read-only here — used to resolve winner display names for the
      // "who won" popup. The model is owned by UsersModule; registering
      // it again just gives this module a handle to the same collection.
      { name: User.name, schema: UserSchema },
    ]),
    WalletModule,
    RealtimeModule,
  ],
  controllers: [GamesController, GamesAdminController],
  providers: [GamesService],
  exports: [GamesService],
})
export class GamesModule {}
