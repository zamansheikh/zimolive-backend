import { Module } from '@nestjs/common';

import { UsersModule } from '../../users/users.module';
import { WalletModule } from '../../wallet/wallet.module';
import { AdminUsersModule } from '../admin-users/admin-users.module';
import { AppUsersController } from './app-users.controller';

@Module({
  imports: [UsersModule, AdminUsersModule, WalletModule],
  controllers: [AppUsersController],
})
export class AppUsersModule {}
