import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

import { AdminOnly } from '../admin/admin-auth/decorators/admin-only.decorator';
import { CurrentAdmin } from '../admin/admin-auth/decorators/current-admin.decorator';
import { RequirePermissions } from '../admin/admin-auth/decorators/require-permissions.decorator';
import { AuthenticatedAdmin } from '../admin/admin-auth/strategies/admin-jwt.strategy';
import { PERMISSIONS } from '../admin/permissions.catalog';
import { AgenciesService } from './agencies.service';
import {
  CreateAgencyDto,
  UpdateAgencyDto,
  UpdateAgencyStatusDto,
} from './dto/agency.dto';
import { AgencyMemberRole } from './schemas/agency-member.schema';
import { AgencyStatus } from './schemas/agency.schema';

@Controller({ path: 'admin/agencies', version: '1' })
@AdminOnly()
export class AgenciesController {
  constructor(private readonly agencies: AgenciesService) {}

  @RequirePermissions(PERMISSIONS.AGENCY_VIEW)
  @Get()
  async list(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('status') status?: AgencyStatus,
    @Query('country') country?: string,
    @Query('search') search?: string,
  ) {
    return this.agencies.list({ page, limit, status, country, search }, admin);
  }

  @RequirePermissions(PERMISSIONS.AGENCY_VIEW)
  @Get(':id')
  async getOne(@Param('id') id: string, @CurrentAdmin() admin: AuthenticatedAdmin) {
    const agency = await this.agencies.findById(id, admin);
    return { agency };
  }

  @RequirePermissions(PERMISSIONS.AGENCY_MANAGE)
  @Post()
  async create(@Body() dto: CreateAgencyDto, @CurrentAdmin() admin: AuthenticatedAdmin) {
    const agency = await this.agencies.create({ ...dto, createdBy: admin.adminId });
    return { agency };
  }

  @RequirePermissions(PERMISSIONS.AGENCY_MANAGE)
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateAgencyDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    const agency = await this.agencies.update(id, dto, admin);
    return { agency };
  }

  @RequirePermissions(PERMISSIONS.AGENCY_MANAGE)
  @Patch(':id/status')
  async updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateAgencyStatusDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    const agency = await this.agencies.updateStatus(id, dto.status, admin);
    return { agency };
  }

  // ----- Hosts under this agency -----

  @RequirePermissions(PERMISSIONS.HOSTS_VIEW)
  @Get(':id/hosts')
  async listHosts(
    @Param('id') id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('search') search?: string,
  ) {
    return this.agencies.listHosts(id, { page, limit, search }, admin);
  }

  @RequirePermissions(PERMISSIONS.HOSTS_ASSIGN_AGENCY)
  @Post(':id/hosts/:userId')
  async assignHost(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    const agency = await this.agencies.assignHost(id, userId, admin);
    return { agency };
  }

  @RequirePermissions(PERMISSIONS.HOSTS_ASSIGN_AGENCY)
  @Patch(':id/hosts/:userId/remove')
  async removeHost(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    const agency = await this.agencies.unassignHost(id, userId, admin);
    return { agency };
  }

  // ----- App-side members (owner / admin / member roles) -----

  @RequirePermissions(PERMISSIONS.AGENCY_VIEW)
  @Get(':id/members')
  async listMembers(
    @Param('id') id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.agencies.listMembers(id, { page, limit }, admin);
  }

  /**
   * Add an app user to the agency. Body: `{ userId, role }` where
   * `role` is `owner`/`admin`/`member`. Upserts — calling again with a
   * different role flips the role.
   */
  @RequirePermissions(PERMISSIONS.AGENCY_MANAGE)
  @Post(':id/members')
  async addMember(
    @Param('id') id: string,
    @Body() body: { userId?: string; role?: string },
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    const userId = body.userId;
    const roleStr = (body.role ?? AgencyMemberRole.MEMBER).toLowerCase();
    if (!userId) {
      throw new BadRequestException({
        code: 'MISSING_USER_ID',
        message: 'userId is required',
      });
    }
    const validRoles = Object.values(AgencyMemberRole) as string[];
    if (!validRoles.includes(roleStr)) {
      throw new BadRequestException({
        code: 'INVALID_ROLE',
        message: `role must be one of ${validRoles.join(', ')}`,
      });
    }
    const member = await this.agencies.addMember(
      id,
      userId,
      roleStr as AgencyMemberRole,
      admin,
    );
    return { member };
  }

  @RequirePermissions(PERMISSIONS.AGENCY_MANAGE)
  @Delete(':id/members/:userId')
  async removeMember(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.agencies.removeMember(id, userId, admin);
  }
}
