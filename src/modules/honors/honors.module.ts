import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { MediaModule } from '../media/media.module';
import {
  UserSvipStatus,
  UserSvipStatusSchema,
} from '../svip/schemas/user-svip-status.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { Wallet, WalletSchema } from '../wallet/schemas/wallet.schema';
import { HonorsAdminController } from './honors-admin.controller';
import { HonorsController, MeHonorsController } from './honors.controller';
import { HonorsService } from './honors.service';
import { HonorMetricsService } from './metrics.service';
import { HonorItem, HonorItemSchema } from './schemas/honor-item.schema';
import { UserHonor, UserHonorSchema } from './schemas/user-honor.schema';

/**
 * HonorsModule. Exports `HonorsService` so the task / event hooks
 * can call `awardByKey()` without going through the admin controller.
 *
 * `MediaModule` is imported for the icon upload endpoints (image +
 * SVGA) — same Cloudinary integration the cosmetics module uses,
 * one-way arrow with no cycle risk.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: HonorItem.name, schema: HonorItemSchema },
      { name: UserHonor.name, schema: UserHonorSchema },
      // Schemas the metrics service reads from. We register them
      // directly (not via the owning modules) so HonorsModule has
      // no module-level dependency on Wallet/Svip/Users — that
      // way those modules can freely import HonorsModule for
      // event hooks without creating a circular dep.
      { name: User.name, schema: UserSchema },
      { name: Wallet.name, schema: WalletSchema },
      { name: UserSvipStatus.name, schema: UserSvipStatusSchema },
    ]),
    MediaModule,
  ],
  controllers: [HonorsController, MeHonorsController, HonorsAdminController],
  providers: [HonorsService, HonorMetricsService],
  // Export both so other modules (wallet, gifts, svip, social) can
  // call evaluateUser on the hot paths.
  exports: [HonorsService, HonorMetricsService],
})
export class HonorsModule {}
