import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { Agency, AgencySchema } from '../../agencies/schemas/agency.schema';
import { Family, FamilySchema } from '../../families/schemas/family.schema';
import { GameBet, GameBetSchema } from '../../games/schemas/game-bet.schema';
import {
  Reseller,
  ResellerSchema,
} from '../../resellers/schemas/reseller.schema';
import { Room, RoomSchema } from '../../rooms/schemas/room.schema';
import { User, UserSchema } from '../../users/schemas/user.schema';
import {
  Transaction,
  TransactionSchema,
} from '../../wallet/schemas/transaction.schema';
import { Wallet, WalletSchema } from '../../wallet/schemas/wallet.schema';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

/**
 * Read-only admin dashboard analytics. Registers handles to the collections
 * it aggregates (owned by their own modules) — no writes happen here.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Wallet.name, schema: WalletSchema },
      { name: Transaction.name, schema: TransactionSchema },
      { name: Room.name, schema: RoomSchema },
      { name: Agency.name, schema: AgencySchema },
      { name: Reseller.name, schema: ResellerSchema },
      { name: Family.name, schema: FamilySchema },
      { name: GameBet.name, schema: GameBetSchema },
    ]),
    AdminAuthModule,
  ],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
