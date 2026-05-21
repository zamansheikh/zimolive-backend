import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';

import { UserStatus } from '../../users/schemas/user.schema';
import { UsersService } from '../../users/users.service';
import { AdminOnly } from '../admin-auth/decorators/admin-only.decorator';
import { CurrentAdmin } from '../admin-auth/decorators/current-admin.decorator';
import { RequirePermissions } from '../admin-auth/decorators/require-permissions.decorator';
import { AuthenticatedAdmin } from '../admin-auth/strategies/admin-jwt.strategy';
import { AdminUsersService } from '../admin-users/admin-users.service';
import { AdminStatus } from '../admin-users/schemas/admin-user.schema';
import { PERMISSIONS } from '../permissions.catalog';
import { BanUserDto, ToggleHostDto } from './dto/ban-user.dto';
import { PromoteUserDto } from './dto/promote-user.dto';

@Controller({ path: 'admin/app-users', version: '1' })
@AdminOnly()
export class AppUsersController {
  constructor(
    private readonly users: UsersService,
    private readonly adminUsers: AdminUsersService,
  ) {}

  @RequirePermissions(PERMISSIONS.USERS_VIEW)
  @Get()
  async list(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('status') status?: UserStatus,
    @Query('isHost') isHost?: string,
    @Query('country') country?: string,
    @Query('search') search?: string,
  ) {
    const isHostBool = isHost === undefined ? undefined : isHost === 'true';
    return this.users.list({ page, limit, status, isHost: isHostBool, country, search });
  }

  /** Distinct countries (with counts) for the App Users country filter.
   *  Declared before `:id` so the literal path isn't captured as an id. */
  @RequirePermissions(PERMISSIONS.USERS_VIEW)
  @Get('countries')
  async countries() {
    const countries = await this.users.distinctCountries();
    return { countries };
  }

  @RequirePermissions(PERMISSIONS.USERS_VIEW)
  @Get(':id')
  async getOne(@Param('id') id: string) {
    const user = await this.users.getByIdOrThrow(id);
    return { user };
  }

  @RequirePermissions(PERMISSIONS.USERS_BAN)
  @Post(':id/ban')
  async ban(
    @Param('id') id: string,
    @Body() dto: BanUserDto,
    @CurrentAdmin() current: AuthenticatedAdmin,
  ) {
    const user = await this.users.ban(id, dto.reason, current.adminId);
    return { user };
  }

  @RequirePermissions(PERMISSIONS.USERS_BAN)
  @Post(':id/unban')
  async unban(@Param('id') id: string) {
    const user = await this.users.unban(id);
    return { user };
  }

  @RequirePermissions(PERMISSIONS.HOSTS_APPROVE)
  @Post(':id/toggle-host')
  async toggleHost(
    @Param('id') id: string,
    @Body() dto: ToggleHostDto,
    @CurrentAdmin() current: AuthenticatedAdmin,
  ) {
    const user = await this.users.setHost(id, dto.isHost, {
      tier: dto.tier,
      approvedBy: current.adminId,
      agencyId: dto.agencyId,
    });
    return { user };
  }

  @RequirePermissions(PERMISSIONS.ADMIN_CREATE, PERMISSIONS.USERS_EDIT)
  @Post(':id/promote-to-admin')
  async promoteToAdmin(
    @Param('id') id: string,
    @Body() dto: PromoteUserDto,
    @CurrentAdmin() current: AuthenticatedAdmin,
  ) {
    const user = await this.users.getByIdOrThrow(id);

    if (user.linkedAdminId) {
      throw new BadRequestException({
        code: 'ALREADY_LINKED',
        message: 'This user is already linked to an admin account',
        details: { linkedAdminId: user.linkedAdminId.toString() },
      });
    }

    const role = await this.adminUsers.findRoleById(dto.roleId);
    if (!role) throw new NotFoundException('Role not found');

    const admin = await this.adminUsers.create({
      email: dto.adminEmail,
      username: dto.adminUsername,
      password: dto.initialPassword,
      displayName: dto.displayName || user.displayName || user.username,
      roleId: dto.roleId,
      scopeType: dto.scopeType,
      scopeId: dto.scopeId,
      createdBy: current.adminId,
    });

    // Link both directions
    admin.linkedUserId = user._id;
    admin.mustChangePassword = true;
    await admin.save();

    await this.users.linkAdmin(user._id.toString(), admin._id.toString());

    return { user: await this.users.findById(user._id.toString()), admin };
  }

  /**
   * Set the user's agency-management powers. Gated on `agency.manage`
   * so only platform admins who can already manage agencies can grant
   * the corresponding app-side power. Accepts a fresh list every time
   * (not a diff) — the UI sends the desired final state.
   */
  @RequirePermissions(PERMISSIONS.AGENCY_MANAGE)
  @Post(':id/agency-powers')
  async setAgencyPowers(
    @Param('id') id: string,
    @Body() dto: { powers?: string[] },
  ) {
    const requested = Array.isArray(dto.powers) ? dto.powers : [];
    // Whitelist: only powers in the catalog can be granted. Anything
    // else is dropped silently rather than 400'd so a stale UI doesn't
    // break the request.
    const allowed = new Set(['agency.create', 'agency.manage']);
    const filtered = requested.filter((p) => allowed.has(p));
    const user = await this.users.setAgencyPowers(id, filtered);
    return { user };
  }

  @RequirePermissions(PERMISSIONS.ADMIN_UPDATE)
  @Post(':id/unlink-admin')
  async unlinkAdmin(@Param('id') id: string) {
    const user = await this.users.getByIdOrThrow(id);
    if (!user.linkedAdminId) {
      throw new BadRequestException({
        code: 'NOT_LINKED',
        message: 'This user has no linked admin account',
      });
    }
    // Disable the linked admin and remove the link. We do NOT delete the
    // admin record — audit logs and history should be preserved.
    const adminId = user.linkedAdminId.toString();
    await this.adminUsers.update(adminId, { status: AdminStatus.DISABLED });
    await this.users.linkAdmin(user._id.toString(), null);
    return { success: true, adminId };
  }
}
