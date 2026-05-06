import { forwardRef, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { CosmeticsModule } from '../cosmetics/cosmetics.module';
import { HonorsModule } from '../honors/honors.module';
import { WalletModule } from '../wallet/wallet.module';
import { SvipAdminController } from './svip-admin.controller';
import { SvipController } from './svip.controller';
import { SvipService } from './svip.service';
import { SvipTier, SvipTierSchema } from './schemas/svip-tier.schema';
import {
  UserSvipStatus,
  UserSvipStatusSchema,
} from './schemas/user-svip-status.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SvipTier.name, schema: SvipTierSchema },
      { name: UserSvipStatus.name, schema: UserSvipStatusSchema },
    ]),
    // Direct-purchase flow debits the user's coin wallet via
    // `WalletService.debit` and creates a SVIP_PURCHASE transaction.
    // WalletModule has no dependency on SvipModule, so this arrow is
    // one-way.
    WalletModule,
    // Tier purchases grant cosmetics; activate flips them on while
    // overriding any non-SVIP item of the same type. Deactivate
    // unequips them. Same one-way dependency arrow as wallet.
    CosmeticsModule,
    // SVIP purchase / activate fires honor evaluations for the
    // SVIP_TIER metric so any honor tied to "reach SVIP N"
    // auto-unlocks. forwardRef keeps Nest's DI graph happy in
    // case any future addition introduces a back-reference;
    // today HonorsModule registers UserSvipStatus directly so
    // there's no module-level cycle.
    forwardRef(() => HonorsModule),
  ],
  controllers: [SvipAdminController, SvipController],
  providers: [SvipService],
  exports: [SvipService, MongooseModule],
})
export class SvipModule {}
