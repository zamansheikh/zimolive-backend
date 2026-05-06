import { forwardRef, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { HonorsModule } from '../honors/honors.module';
import { AdminWalletOptionsController } from './admin-wallet-options.controller';
import { AdminWalletController } from './admin-wallet.controller';
import { ExchangeOption, ExchangeOptionSchema } from './schemas/exchange-option.schema';
import { RechargePackage, RechargePackageSchema } from './schemas/recharge-package.schema';
import { Transaction, TransactionSchema } from './schemas/transaction.schema';
import { Wallet, WalletSchema } from './schemas/wallet.schema';
import { WalletController } from './wallet.controller';
import { WalletOptionsService } from './wallet-options.service';
import { WalletService } from './wallet.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Wallet.name, schema: WalletSchema },
      { name: Transaction.name, schema: TransactionSchema },
      { name: RechargePackage.name, schema: RechargePackageSchema },
      { name: ExchangeOption.name, schema: ExchangeOptionSchema },
    ]),
    // Wallet posts honor-evaluation hooks after recharge / gift
    // transfers. forwardRef keeps Nest's DI graph happy if any
    // future module adds a back-reference; today there's no
    // module-level cycle (HonorsModule registers the wallet
    // schema directly, not via WalletModule).
    forwardRef(() => HonorsModule),
  ],
  controllers: [
    WalletController,
    AdminWalletController,
    AdminWalletOptionsController,
  ],
  providers: [WalletService, WalletOptionsService],
  exports: [WalletService, WalletOptionsService],
})
export class WalletModule {}
