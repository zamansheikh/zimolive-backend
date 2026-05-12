import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { AppAgenciesService } from './app-agencies.service';
import {
  CreateMyAgencyDto,
  DecideRequestDto,
  JoinRequestDto,
  SetMemberRoleDto,
} from './dto/app-agency.dto';
import { AgencyJoinRequestStatus } from './schemas/agency-join-request.schema';

/**
 * Mobile-facing agency endpoints. The admin panel still owns the
 * platform CRUD via `AgenciesController` at `/v1/admin/agencies`.
 *
 * Here we expose:
 *   • Public browse — anyone can look up agencies (used by the Browse
 *     screen on the My Agency page).
 *   • Authenticated `/me` — the caller's agency situation in one call.
 *   • Join / leave / cancel — the membership lifecycle.
 *   • Owner / admin actions — roster, ranking, join-requests, decide,
 *     kick, role change.
 *   • Create-from-app — gated on `User.agencyPowers` containing
 *     `agency.create`.
 */
@Controller({ path: 'agencies', version: '1' })
export class AppAgenciesController {
  constructor(private readonly agencies: AppAgenciesService) {}

  // ─── Discovery ───────────────────────────────────────────────

  @Public()
  @Get()
  async list(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('search') search?: string,
  ) {
    return this.agencies.listPublic({ page, limit, search });
  }

  @Get('me')
  async fetchMine(@CurrentUser() current: AuthenticatedUser) {
    return this.agencies.fetchMine(current.userId);
  }

  // ─── Membership lifecycle ───────────────────────────────────

  @Post(':id/join')
  async requestJoin(
    @CurrentUser() current: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: JoinRequestDto,
  ) {
    const req = await this.agencies.requestJoin(
      current.userId,
      id,
      dto.message ?? '',
    );
    return { request: req };
  }

  @Post('requests/:reqId/cancel')
  async cancelMyRequest(
    @CurrentUser() current: AuthenticatedUser,
    @Param('reqId') reqId: string,
  ) {
    return this.agencies.cancelMyRequest(current.userId, reqId);
  }

  @Post('leave')
  async leave(@CurrentUser() current: AuthenticatedUser) {
    return this.agencies.leaveAgency(current.userId);
  }

  // ─── Roster + ranking ───────────────────────────────────────

  @Get(':id/members')
  async listMembers(
    @CurrentUser() current: AuthenticatedUser,
    @Param('id') id: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.agencies.listMembers(id, { page, limit }, current.userId);
  }

  @Get(':id/ranking')
  async ranking(
    @CurrentUser() current: AuthenticatedUser,
    @Param('id') id: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.agencies.ranking(id, { page, limit }, current.userId);
  }

  // ─── Join request moderation ────────────────────────────────

  @Get(':id/join-requests')
  async listJoinRequests(
    @CurrentUser() current: AuthenticatedUser,
    @Param('id') id: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('status') status?: AgencyJoinRequestStatus,
  ) {
    return this.agencies.listJoinRequests(
      id,
      { page, limit, status },
      current.userId,
    );
  }

  @Post(':id/join-requests/:reqId/decide')
  async decideRequest(
    @CurrentUser() current: AuthenticatedUser,
    @Param('id') id: string,
    @Param('reqId') reqId: string,
    @Body() dto: DecideRequestDto,
  ) {
    return this.agencies.decideRequest(
      id,
      reqId,
      current.userId,
      dto.decision,
      dto.note ?? '',
    );
  }

  // ─── Member moderation ─────────────────────────────────────

  @Delete(':id/members/:userId')
  async kickMember(
    @CurrentUser() current: AuthenticatedUser,
    @Param('id') id: string,
    @Param('userId') userId: string,
  ) {
    return this.agencies.kickMember(id, userId, current.userId);
  }

  @Patch(':id/members/:userId/role')
  async setMemberRole(
    @CurrentUser() current: AuthenticatedUser,
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Body() dto: SetMemberRoleDto,
  ) {
    const { member } = await this.agencies.setMemberRole(
      id,
      userId,
      current.userId,
      dto.role,
    );
    return { member };
  }

  // ─── Found a new agency ─────────────────────────────────────

  @Post()
  async createMine(
    @CurrentUser() current: AuthenticatedUser,
    @Body() dto: CreateMyAgencyDto,
  ) {
    const { agency, member } = await this.agencies.createFromApp(
      current.userId,
      dto,
    );
    return { agency, member };
  }
}
