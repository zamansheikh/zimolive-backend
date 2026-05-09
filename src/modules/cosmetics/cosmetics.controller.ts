import {
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { CurrentUser, AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CosmeticsService } from './cosmetics.service';

/**
 * Public, read-only listing of any user's owned cosmetics. Powers
 * the "Vehicle / Frame / Theme" sections on the public profile
 * page. We strip expired rows and the per-user external ref so the
 * payload only carries what's needed to render — name, type, icon,
 * equipped flag — keeping the public profile flow a single small
 * round-trip per section.
 */
@Controller({ path: 'cosmetics', version: '1' })
export class PublicCosmeticsController {
  constructor(private readonly cosmetics: CosmeticsService) {}

  /**
   * Batch-fetch the public catalog projection for a comma-separated
   * list of cosmetic ids. Returns whatever subset is found + still
   * active — clients are expected to merge against their own keys
   * and tolerate missing entries (the catalog row may have been
   * retired between when the ID list was built and when the lookup
   * fires).
   *
   * Powers the SVIP page's tier-granted-item preview: tiers can grant
   * cosmetics that aren't sold via the store, and so don't surface in
   * `/store/listings`. This endpoint fills that gap with one round-trip.
   */
  @Public()
  @Get()
  async listByIds(@Query('ids') ids?: string) {
    const list = (ids ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (list.length === 0) return { items: [] };
    const docs = await this.cosmetics.findActiveByIds(list);
    const items = docs.map((d) => ({
      id: d._id.toString(),
      code: d.code,
      name: d.name,
      type: d.type,
      previewUrl: d.previewUrl ?? '',
      assetType: d.assetType ?? 'image',
      assetUrl: d.assetUrl ?? '',
      rarity: d.rarity ?? 1,
    }));
    return { items };
  }

  @Public()
  @Get('users/:userId')
  async forUser(@Param('userId') userId: string) {
    const rows = await this.cosmetics.listUserCosmetics(userId);
    // Drop expired rows + flatten the populated cosmetic item into
    // the visible projection. The mobile renderer only needs the
    // catalog metadata + the equipped flag.
    const now = new Date();
    const items = rows
      .filter((r) => r.expiresAt == null || r.expiresAt > now)
      .map((r) => {
        const item = r.cosmeticItemId as unknown as
          | {
              _id: { toString(): string };
              code: string;
              name: { en: string; bn?: string };
              type: string;
              previewUrl?: string;
              assetType?: string;
              assetUrl?: string;
              rarity?: number;
            }
          | null;
        return {
          id: r._id.toString(),
          equipped: r.equipped,
          source: r.source,
          svipTier: r.svipTier ?? null,
          acquiredAt: r.acquiredAt,
          cosmetic: item
            ? {
                id: item._id.toString(),
                code: item.code,
                name: item.name,
                type: item.type,
                previewUrl: item.previewUrl ?? '',
                assetType: item.assetType ?? 'image',
                assetUrl: item.assetUrl ?? '',
                rarity: item.rarity ?? 1,
              }
            : null,
        };
      })
      .filter((r) => r.cosmetic != null);
    return { items };
  }
}

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
