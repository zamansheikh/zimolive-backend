import {
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { CurrentUser, AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CosmeticsService } from './cosmetics.service';

/**
 * User-facing inventory endpoints. The admin counterpart is
 * CosmeticsAdminController.
 */
@Controller({ path: 'me/cosmetics', version: '1' })
@UseGuards(JwtAuthGuard)
export class CosmeticsController {
  constructor(private readonly cosmetics: CosmeticsService) {}

  @Get()
  async myCosmetics(@CurrentUser() current: AuthenticatedUser) {
    const items = await this.cosmetics.listUserCosmetics(current.userId);
    return { items };
  }

  /**
   * Bulk fetch the equipped cosmetics for a list of users. Used by the
   * audio-room view to hydrate every visible seat / chat author in one
   * round-trip. `userIds` is comma-separated.
   */
  @Get('equipped/bulk')
  async bulkEquipped(@Query('userIds') userIds?: string) {
    const ids = (userIds ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (ids.length === 0) return { items: [] };
    const items = await this.cosmetics.listEquippedForUsers(ids);
    return { items };
  }

  /**
   * Equip a cosmetic the user owns. Other items of the same type get
   * unequipped automatically (one frame, one vehicle, etc., active at a time).
   */
  @Post(':userCosmeticId/equip')
  async equip(
    @CurrentUser() current: AuthenticatedUser,
    @Param('userCosmeticId') userCosmeticId: string,
  ) {
    const cosmetic = await this.cosmetics.equip(current.userId, userCosmeticId);
    return { cosmetic };
  }

  /**
   * Take an item off without equipping a different one of the same
   * type. Used by the My Items "Unequip" button. Idempotent.
   */
  @Post(':userCosmeticId/unequip')
  async unequip(
    @CurrentUser() current: AuthenticatedUser,
    @Param('userCosmeticId') userCosmeticId: string,
  ) {
    const cosmetic = await this.cosmetics.unequip(
      current.userId,
      userCosmeticId,
    );
    return { cosmetic };
  }
}
