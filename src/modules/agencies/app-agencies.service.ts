import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';

import { NumericIdService } from '../common/numeric-id.service';
import { CounterScope } from '../common/schemas/counter.schema';
import { User, UserDocument } from '../users/schemas/user.schema';
import { UsersService } from '../users/users.service';
import {
  Agency,
  AgencyDocument,
  AgencyStatus,
} from './schemas/agency.schema';
import {
  AgencyJoinRequest,
  AgencyJoinRequestDocument,
  AgencyJoinRequestStatus,
} from './schemas/agency-join-request.schema';
import {
  AgencyMember,
  AgencyMemberDocument,
  AgencyMemberRole,
} from './schemas/agency-member.schema';

/**
 * App-facing agency service. Handles flows that originate from the mobile
 * app — user wants to browse / apply / quit, owner wants to approve / kick
 * / promote / view the roster + ranking. The admin-side `AgenciesService`
 * still owns the platform-level CRUD (create / suspend / commission rate).
 *
 * Authorisation here is by ROLE inside the agency, not by admin permission:
 *   • owner — full agency moderation
 *   • admin — approve / reject join requests, kick members
 *   • member — read-only
 *
 * The `User.agencyPowers` array gates a separate, narrower concept: who
 * can FOUND a new agency from the app. Once founded, control of that
 * agency lives in `AgencyMember.role`.
 */
@Injectable()
export class AppAgenciesService {
  constructor(
    @InjectModel(Agency.name)
    private readonly agencyModel: Model<AgencyDocument>,
    @InjectModel(AgencyMember.name)
    private readonly memberModel: Model<AgencyMemberDocument>,
    @InjectModel(AgencyJoinRequest.name)
    private readonly requestModel: Model<AgencyJoinRequestDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    private readonly numericIds: NumericIdService,
    // Joining an agency auto-promotes the user to host (Trainee tier).
    // Delegating the lifecycle to UsersService keeps the host invariants
    // (isHost flag + hostProfile shape) in one place.
    private readonly users: UsersService,
  ) {}

  // ────────────────────────────────────────────────────────────
  // Discovery
  // ────────────────────────────────────────────────────────────

  /**
   * List active agencies for the Browse screen. Paginated; `search` runs
   * against `name`/`code`/numericId.
   */
  async listPublic(params: {
    page?: number;
    limit?: number;
    search?: string;
  }) {
    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(50, Math.max(1, params.limit ?? 20));
    const skip = (page - 1) * limit;

    const filter: FilterQuery<AgencyDocument> = {
      status: AgencyStatus.ACTIVE,
    };
    if (params.search) {
      const q = params.search.trim();
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      const or: FilterQuery<AgencyDocument>[] = [
        { name: regex },
        { code: regex },
      ];
      if (/^\d{1,7}$/.test(q)) {
        or.push({ numericId: parseInt(q, 10) });
      }
      filter.$or = or;
    }

    const [items, total] = await Promise.all([
      this.agencyModel
        .find(filter)
        .sort({ totalDiamondsEarned: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      this.agencyModel.countDocuments(filter).exec(),
    ]);
    return { items, page, limit, total };
  }

  /**
   * Combined "what is my agency situation?" payload — the caller's
   * agency (if any) + their role + any pending request. Drives the
   * My Agency landing page in one round-trip.
   */
  async fetchMine(userId: string) {
    if (!Types.ObjectId.isValid(userId)) return _emptyMine();
    const userOid = new Types.ObjectId(userId);

    const member = await this.memberModel
      .findOne({ userId: userOid })
      .lean()
      .exec();
    let agency: AgencyDocument | null = null;
    if (member) {
      agency = await this.agencyModel.findById(member.agencyId).exec();
    }

    const pendingRequest = await this.requestModel
      .findOne({ userId: userOid, status: AgencyJoinRequestStatus.PENDING })
      .lean()
      .exec();

    const user = await this.userModel
      .findById(userOid)
      .select({ agencyPowers: 1 })
      .lean()
      .exec();

    return {
      member: member ?? null,
      agency: agency?.toJSON() ?? null,
      pendingRequest: pendingRequest ?? null,
      powers: user?.agencyPowers ?? [],
    };
  }

  // ────────────────────────────────────────────────────────────
  // Membership lifecycle (user-driven)
  // ────────────────────────────────────────────────────────────

  /**
   * Submit a join request. Rejected if:
   *   • the caller is already in another agency,
   *   • the caller already has a pending request to this agency,
   *   • the target agency is suspended / terminated.
   */
  async requestJoin(
    userId: string,
    agencyId: string,
    message: string,
  ): Promise<AgencyJoinRequestDocument> {
    if (!Types.ObjectId.isValid(userId) || !Types.ObjectId.isValid(agencyId)) {
      throw new NotFoundException('Agency not found');
    }
    const userOid = new Types.ObjectId(userId);
    const agencyOid = new Types.ObjectId(agencyId);

    const agency = await this.agencyModel.findById(agencyOid).exec();
    if (!agency) throw new NotFoundException('Agency not found');
    if (agency.status !== AgencyStatus.ACTIVE) {
      throw new ForbiddenException({
        code: 'AGENCY_INACTIVE',
        message: 'This agency is not accepting new members',
      });
    }

    // Already a member somewhere?
    const existing = await this.memberModel
      .findOne({ userId: userOid })
      .lean()
      .exec();
    if (existing) {
      if (existing.agencyId.equals(agencyOid)) {
        throw new ConflictException({
          code: 'ALREADY_MEMBER',
          message: 'You are already a member of this agency',
        });
      }
      throw new ConflictException({
        code: 'ALREADY_IN_OTHER_AGENCY',
        message: 'Leave your current agency before joining another',
      });
    }

    // Reuse / upsert via partial-unique index — duplicate pending
    // requests would 11000.
    try {
      return await this.requestModel.create({
        agencyId: agencyOid,
        userId: userOid,
        status: AgencyJoinRequestStatus.PENDING,
        message: message.trim(),
      });
    } catch (err: any) {
      if (err?.code === 11000) {
        throw new ConflictException({
          code: 'REQUEST_PENDING',
          message: 'You already have a pending request to this agency',
        });
      }
      throw err;
    }
  }

  /** User-initiated cancel of their own pending request. */
  async cancelMyRequest(
    userId: string,
    requestId: string,
  ): Promise<{ ok: true }> {
    if (
      !Types.ObjectId.isValid(userId) ||
      !Types.ObjectId.isValid(requestId)
    ) {
      throw new NotFoundException('Request not found');
    }
    const req = await this.requestModel.findById(requestId).exec();
    if (!req) throw new NotFoundException('Request not found');
    if (!req.userId.equals(new Types.ObjectId(userId))) {
      throw new ForbiddenException('Not your request');
    }
    if (req.status !== AgencyJoinRequestStatus.PENDING) {
      throw new BadRequestException({
        code: 'REQUEST_NOT_PENDING',
        message: 'Request is already decided',
      });
    }
    req.status = AgencyJoinRequestStatus.CANCELLED;
    req.decidedAt = new Date();
    await req.save();
    return { ok: true };
  }

  /**
   * User-initiated leave. Owners can't leave directly — they must
   * transfer ownership first. Last member (an empty agency owner) is
   * a no-op the admin panel can sweep separately.
   */
  async leaveAgency(userId: string): Promise<{ ok: true }> {
    if (!Types.ObjectId.isValid(userId)) return { ok: true };
    const userOid = new Types.ObjectId(userId);
    const member = await this.memberModel.findOne({ userId: userOid }).exec();
    if (!member) return { ok: true };
    if (member.role === AgencyMemberRole.OWNER) {
      throw new ForbiddenException({
        code: 'OWNER_CANNOT_LEAVE',
        message:
          'Transfer ownership to another member before leaving the agency',
      });
    }
    await this.memberModel.deleteOne({ _id: member._id }).exec();
    await this.agencyModel
      .updateOne(
        { _id: member.agencyId, hostCount: { $gt: 0 } },
        { $inc: { hostCount: -1 } },
      )
      .exec();
    return { ok: true };
  }

  // ────────────────────────────────────────────────────────────
  // Owner / admin actions
  // ────────────────────────────────────────────────────────────

  /** Internal helper — resolve actor's role for the given agency. */
  private async actorRole(
    agencyId: Types.ObjectId,
    actorId: string,
  ): Promise<AgencyMemberRole | null> {
    if (!Types.ObjectId.isValid(actorId)) return null;
    const me = await this.memberModel
      .findOne({
        agencyId,
        userId: new Types.ObjectId(actorId),
      })
      .lean()
      .exec();
    return me?.role ?? null;
  }

  /** Owner OR admin OR (super-power) `agency.manage`. */
  private async assertCanModerate(
    agencyId: Types.ObjectId,
    actorId: string,
  ): Promise<AgencyMemberRole | 'super'> {
    const role = await this.actorRole(agencyId, actorId);
    if (role === AgencyMemberRole.OWNER) return role;
    if (role === AgencyMemberRole.ADMIN) return role;
    // Global override — admin granted the user `agency.manage` power.
    const u = await this.userModel
      .findById(actorId)
      .select({ agencyPowers: 1 })
      .lean()
      .exec();
    if (u?.agencyPowers?.includes('agency.manage')) return 'super';
    throw new ForbiddenException({
      code: 'NOT_AGENCY_STAFF',
      message: 'Only the agency owner or admins can do that',
    });
  }

  /** Owner only (or super power). */
  private async assertCanGovern(
    agencyId: Types.ObjectId,
    actorId: string,
  ): Promise<AgencyMemberRole | 'super'> {
    const role = await this.actorRole(agencyId, actorId);
    if (role === AgencyMemberRole.OWNER) return role;
    const u = await this.userModel
      .findById(actorId)
      .select({ agencyPowers: 1 })
      .lean()
      .exec();
    if (u?.agencyPowers?.includes('agency.manage')) return 'super';
    throw new ForbiddenException({
      code: 'NOT_AGENCY_OWNER',
      message: 'Only the agency owner can do that',
    });
  }

  async listMembers(
    agencyId: string,
    params: { page?: number; limit?: number },
    actorId: string,
  ) {
    if (!Types.ObjectId.isValid(agencyId)) {
      throw new NotFoundException('Agency not found');
    }
    const agencyOid = new Types.ObjectId(agencyId);
    // Public roster — every member of the agency can see the list.
    const role = await this.actorRole(agencyOid, actorId);
    if (!role) {
      // Not a member — but a `agency.manage` power user can still see.
      const u = await this.userModel
        .findById(actorId)
        .select({ agencyPowers: 1 })
        .lean()
        .exec();
      if (!u?.agencyPowers?.includes('agency.manage')) {
        throw new ForbiddenException({
          code: 'NOT_AGENCY_MEMBER',
          message: 'Join the agency to see its roster',
        });
      }
    }
    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(100, Math.max(1, params.limit ?? 50));
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      this.memberModel
        .find({ agencyId: agencyOid })
        .sort({ role: 1, joinedAt: 1 })
        .skip(skip)
        .limit(limit)
        .populate(
          'userId',
          'displayName username avatarUrl numericId level isHost',
        )
        .lean()
        .exec(),
      this.memberModel.countDocuments({ agencyId: agencyOid }).exec(),
    ]);
    return { items, page, limit, total };
  }

  /** Member ranking — sorted by lifetime diamonds contributed, desc. */
  async ranking(
    agencyId: string,
    params: { page?: number; limit?: number },
    actorId: string,
  ) {
    if (!Types.ObjectId.isValid(agencyId)) {
      throw new NotFoundException('Agency not found');
    }
    const agencyOid = new Types.ObjectId(agencyId);
    const role = await this.actorRole(agencyOid, actorId);
    if (!role) {
      const u = await this.userModel
        .findById(actorId)
        .select({ agencyPowers: 1 })
        .lean()
        .exec();
      if (!u?.agencyPowers?.includes('agency.manage')) {
        throw new ForbiddenException({
          code: 'NOT_AGENCY_MEMBER',
          message: 'Join the agency to see its ranking',
        });
      }
    }
    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(100, Math.max(1, params.limit ?? 50));
    const skip = (page - 1) * limit;

    const items = await this.memberModel
      .find({ agencyId: agencyOid })
      .sort({ diamondsContributed: -1, liveMinutes: -1 })
      .skip(skip)
      .limit(limit)
      .populate(
        'userId',
        'displayName username avatarUrl numericId level isHost',
      )
      .lean()
      .exec();
    return { items, page, limit };
  }

  async listJoinRequests(
    agencyId: string,
    params: {
      page?: number;
      limit?: number;
      status?: AgencyJoinRequestStatus;
    },
    actorId: string,
  ) {
    if (!Types.ObjectId.isValid(agencyId)) {
      throw new NotFoundException('Agency not found');
    }
    const agencyOid = new Types.ObjectId(agencyId);
    await this.assertCanModerate(agencyOid, actorId);

    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(100, Math.max(1, params.limit ?? 50));
    const skip = (page - 1) * limit;
    const filter: FilterQuery<AgencyJoinRequestDocument> = {
      agencyId: agencyOid,
      status: params.status ?? AgencyJoinRequestStatus.PENDING,
    };

    const [items, total] = await Promise.all([
      this.requestModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate(
          'userId',
          'displayName username avatarUrl numericId level isHost',
        )
        .lean()
        .exec(),
      this.requestModel.countDocuments(filter).exec(),
    ]);
    return { items, page, limit, total };
  }

  async decideRequest(
    agencyId: string,
    requestId: string,
    actorId: string,
    decision: 'approve' | 'reject',
    note: string,
  ) {
    if (
      !Types.ObjectId.isValid(agencyId) ||
      !Types.ObjectId.isValid(requestId)
    ) {
      throw new NotFoundException('Request not found');
    }
    const agencyOid = new Types.ObjectId(agencyId);
    await this.assertCanModerate(agencyOid, actorId);

    const req = await this.requestModel.findById(requestId).exec();
    if (!req || !req.agencyId.equals(agencyOid)) {
      throw new NotFoundException('Request not found');
    }
    if (req.status !== AgencyJoinRequestStatus.PENDING) {
      throw new BadRequestException({
        code: 'REQUEST_NOT_PENDING',
        message: 'Request is already decided',
      });
    }

    if (decision === 'approve') {
      // Same race-check the user-side has: the applicant might have
      // joined a different agency between request and approval.
      const alreadySomewhere = await this.memberModel
        .findOne({ userId: req.userId })
        .lean()
        .exec();
      if (alreadySomewhere) {
        throw new ConflictException({
          code: 'APPLICANT_ALREADY_IN_AGENCY',
          message: 'Applicant is already a member of an agency',
        });
      }
      await this.memberModel.create({
        agencyId: agencyOid,
        userId: req.userId,
        role: AgencyMemberRole.MEMBER,
        joinedAt: new Date(),
      });
      await this.agencyModel
        .updateOne({ _id: agencyOid }, { $inc: { hostCount: 1 } })
        .exec();
      // Joining an agency auto-promotes the user to host. Idempotent
      // — if they were already a host, only the hostProfile.agencyId
      // is updated (tier / earnings / hours stay put).
      await this.users.ensureHostForAgency(
        req.userId.toString(),
        agencyOid.toString(),
        actorId,
      );
      req.status = AgencyJoinRequestStatus.APPROVED;
    } else {
      req.status = AgencyJoinRequestStatus.REJECTED;
    }
    req.decidedBy = new Types.ObjectId(actorId);
    req.decidedAt = new Date();
    req.decisionNote = note.trim();
    await req.save();
    return { request: req.toJSON() };
  }

  /** Owner / admin removes a member. Owner cannot be kicked. */
  async kickMember(
    agencyId: string,
    targetUserId: string,
    actorId: string,
  ): Promise<{ ok: true }> {
    if (
      !Types.ObjectId.isValid(agencyId) ||
      !Types.ObjectId.isValid(targetUserId)
    ) {
      throw new NotFoundException('Member not found');
    }
    const agencyOid = new Types.ObjectId(agencyId);
    const targetOid = new Types.ObjectId(targetUserId);
    await this.assertCanModerate(agencyOid, actorId);

    if (targetOid.equals(new Types.ObjectId(actorId))) {
      throw new BadRequestException({
        code: 'CANNOT_KICK_SELF',
        message: 'Use the Leave action instead',
      });
    }
    const target = await this.memberModel
      .findOne({ agencyId: agencyOid, userId: targetOid })
      .exec();
    if (!target) throw new NotFoundException('Member not found');
    if (target.role === AgencyMemberRole.OWNER) {
      throw new ForbiddenException({
        code: 'CANNOT_KICK_OWNER',
        message: 'The agency owner cannot be kicked',
      });
    }
    // Admins can only kick members; owners can kick admins + members.
    const actorRole = await this.actorRole(agencyOid, actorId);
    if (
      actorRole === AgencyMemberRole.ADMIN &&
      target.role === AgencyMemberRole.ADMIN
    ) {
      throw new ForbiddenException({
        code: 'ADMIN_CANNOT_KICK_ADMIN',
        message: 'Only the owner can remove an admin',
      });
    }
    await this.memberModel.deleteOne({ _id: target._id }).exec();
    await this.agencyModel
      .updateOne(
        { _id: agencyOid, hostCount: { $gt: 0 } },
        { $inc: { hostCount: -1 } },
      )
      .exec();
    return { ok: true };
  }

  async setMemberRole(
    agencyId: string,
    targetUserId: string,
    actorId: string,
    role: AgencyMemberRole,
  ): Promise<{ member: AgencyMemberDocument }> {
    if (
      !Types.ObjectId.isValid(agencyId) ||
      !Types.ObjectId.isValid(targetUserId)
    ) {
      throw new NotFoundException('Member not found');
    }
    const agencyOid = new Types.ObjectId(agencyId);
    const targetOid = new Types.ObjectId(targetUserId);
    await this.assertCanGovern(agencyOid, actorId);

    if (role === AgencyMemberRole.OWNER) {
      throw new ForbiddenException({
        code: 'USE_TRANSFER_OWNERSHIP',
        message: 'Use the transfer-ownership flow to change owner',
      });
    }
    const target = await this.memberModel
      .findOne({ agencyId: agencyOid, userId: targetOid })
      .exec();
    if (!target) throw new NotFoundException('Member not found');
    if (target.role === AgencyMemberRole.OWNER) {
      throw new ForbiddenException({
        code: 'CANNOT_DEMOTE_OWNER',
        message: 'Transfer ownership first',
      });
    }
    target.role = role;
    await target.save();
    return { member: target };
  }

  // ────────────────────────────────────────────────────────────
  // Create-from-app
  // ────────────────────────────────────────────────────────────

  /**
   * Found a new agency from the mobile app. Gated on the user holding
   * the `agency.create` power. Caller becomes the owner of the new
   * agency. Code uniqueness is enforced by the existing unique index.
   */
  async createFromApp(
    userId: string,
    input: {
      name: string;
      code: string;
      description?: string;
      country?: string;
      contactEmail?: string;
      contactPhone?: string;
    },
  ): Promise<{ agency: AgencyDocument; member: AgencyMemberDocument }> {
    if (!Types.ObjectId.isValid(userId)) {
      throw new ForbiddenException('Not authenticated');
    }
    const user = await this.userModel
      .findById(userId)
      .select({ agencyPowers: 1 })
      .lean()
      .exec();
    if (!user?.agencyPowers?.includes('agency.create')) {
      throw new ForbiddenException({
        code: 'NO_AGENCY_CREATE_POWER',
        message: 'You do not have permission to create an agency',
      });
    }
    // Can't found a new agency while already a member of one.
    const existing = await this.memberModel
      .findOne({ userId: new Types.ObjectId(userId) })
      .lean()
      .exec();
    if (existing) {
      throw new ConflictException({
        code: 'ALREADY_IN_AGENCY',
        message: 'Leave your current agency first',
      });
    }

    const codeUpper = input.code.trim().toUpperCase();
    const exists = await this.agencyModel
      .countDocuments({ code: codeUpper })
      .exec();
    if (exists) {
      throw new ConflictException({
        code: 'AGENCY_CODE_TAKEN',
        message: `Agency code "${codeUpper}" is already taken`,
      });
    }

    const agency = await this.numericIds.createWithId(
      CounterScope.AGENCY,
      (numericId) =>
        this.agencyModel.create({
          numericId,
          name: input.name.trim(),
          code: codeUpper,
          description: input.description?.trim() ?? '',
          country: (input.country ?? 'BD').toUpperCase(),
          contactEmail: input.contactEmail?.trim() ?? '',
          contactPhone: input.contactPhone?.trim() ?? '',
          status: AgencyStatus.ACTIVE,
          hostCount: 1,
          createdBy: null,
        }),
    );
    const member = await this.memberModel.create({
      agencyId: agency._id,
      userId: new Types.ObjectId(userId),
      role: AgencyMemberRole.OWNER,
      joinedAt: new Date(),
    });
    // Founding an agency auto-promotes the founder to host — they're
    // the owner so the "join → host" rule applies to them too. No-op
    // when they're already a host (just attaches the new agency).
    await this.users.ensureHostForAgency(userId, agency._id.toString());
    return { agency, member };
  }
}

function _emptyMine() {
  return {
    member: null,
    agency: null,
    pendingRequest: null,
    powers: [] as string[],
  };
}
