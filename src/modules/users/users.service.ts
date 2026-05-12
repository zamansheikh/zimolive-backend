import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';

import { CounterScope } from '../common/schemas/counter.schema';
import { NumericIdService } from '../common/numeric-id.service';
import {
  Family,
  FamilyDocument,
} from '../families/schemas/family.schema';
import {
  FamilyMember,
  FamilyMemberDocument,
  FamilyMemberStatus,
} from '../families/schemas/family-member.schema';
import {
  DeviceToken,
  DeviceTokenDocument,
} from '../fcm/schemas/device-token.schema';
import { Room, RoomDocument } from '../rooms/schemas/room.schema';
import {
  UserSvipStatus,
  UserSvipStatusDocument,
} from '../svip/schemas/user-svip-status.schema';
import {
  AuthProvider,
  HostTier,
  User,
  UserDocument,
  UserGender,
  UserStatus,
} from './schemas/user.schema';

export interface ListUsersParams {
  page?: number;
  limit?: number;
  status?: UserStatus;
  isHost?: boolean;
  country?: string;
  search?: string;
  /** Filter to hosts assigned to this agency (only applied if isHost=true). */
  agencyId?: string;
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Room.name) private readonly roomModel: Model<RoomDocument>,
    @InjectModel(Family.name)
    private readonly familyModel: Model<FamilyDocument>,
    @InjectModel(FamilyMember.name)
    private readonly familyMemberModel: Model<FamilyMemberDocument>,
    @InjectModel(UserSvipStatus.name)
    private readonly svipStatusModel: Model<UserSvipStatusDocument>,
    @InjectModel(DeviceToken.name)
    private readonly deviceTokenModel: Model<DeviceTokenDocument>,
    private readonly numericIds: NumericIdService,
  ) {}

  /**
   * Resolve the data the mobile profile pages render *alongside* the
   * core user fields: the user's family (if any) and SVIP tier.
   * Both lookups are tiny and indexed; we run them in parallel and
   * the controller embeds them onto the response. Either piece may
   * be null when the user isn't in a family / hasn't earned SVIP.
   */
  async getProfileEnrichment(userId: string): Promise<{
    family: { id: string; name: string; level: number } | null;
    svipLevel: number;
  }> {
    if (!Types.ObjectId.isValid(userId)) {
      return { family: null, svipLevel: 0 };
    }
    const userOid = new Types.ObjectId(userId);
    const [membership, svipStatus] = await Promise.all([
      this.familyMemberModel
        .findOne({ userId: userOid, status: FamilyMemberStatus.ACTIVE })
        .select('familyId')
        .lean()
        .exec(),
      this.svipStatusModel
        .findOne({ userId: userOid })
        .select('currentLevel')
        .lean()
        .exec(),
    ]);
    let family: { id: string; name: string; level: number } | null = null;
    if (membership) {
      const fam = await this.familyModel
        .findById(membership.familyId)
        .select('name level')
        .lean()
        .exec();
      if (fam) {
        family = {
          id: fam._id.toString(),
          name: fam.name ?? '',
          level: fam.level ?? 1,
        };
      }
    }
    return {
      family,
      svipLevel: svipStatus?.currentLevel ?? 0,
    };
  }

  async findById(id: string): Promise<UserDocument | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return this.userModel.findById(id).exec();
  }

  async findByNumericId(numericId: number): Promise<UserDocument | null> {
    if (!Number.isInteger(numericId)) return null;
    return this.userModel.findOne({ numericId }).exec();
  }

  async findByEmail(email: string, withPassword = false): Promise<UserDocument | null> {
    const query = this.userModel.findOne({ email: email.toLowerCase() });
    if (withPassword) query.select('+passwordHash');
    return query.exec();
  }

  async findByPhone(phone: string): Promise<UserDocument | null> {
    return this.userModel.findOne({ phone }).exec();
  }

  async findByUsername(username: string): Promise<UserDocument | null> {
    return this.userModel.findOne({ username: username.toLowerCase() }).exec();
  }

  async getByIdOrThrow(id: string): Promise<UserDocument> {
    const user = await this.findById(id);
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async createWithEmail(params: {
    email: string;
    passwordHash: string;
    username?: string;
    displayName?: string;
  }): Promise<UserDocument> {
    return this.numericIds.createWithId(CounterScope.USER, (numericId) =>
      this.userModel.create({
        numericId,
        email: params.email.toLowerCase(),
        passwordHash: params.passwordHash,
        username: params.username?.toLowerCase(),
        displayName: params.displayName || params.username || '',
        providers: [AuthProvider.EMAIL],
        emailVerified: false,
      }),
    );
  }

  async createWithPhone(params: {
    phone: string;
    username?: string;
    displayName?: string;
  }): Promise<UserDocument> {
    return this.numericIds.createWithId(CounterScope.USER, (numericId) =>
      this.userModel.create({
        numericId,
        phone: params.phone,
        username: params.username?.toLowerCase(),
        displayName: params.displayName || '',
        providers: [AuthProvider.PHONE],
        phoneVerified: true,
      }),
    );
  }

  /** Find an existing user by Google sub OR by email (email-verified Google login). */
  async findByGoogleIdOrEmail(googleId: string, email: string): Promise<UserDocument | null> {
    return this.userModel
      .findOne({ $or: [{ googleId }, { email: email.toLowerCase() }] })
      .exec();
  }

  async createWithGoogle(params: {
    email: string;
    googleId: string;
    displayName?: string;
    avatarUrl?: string;
  }): Promise<UserDocument> {
    return this.numericIds.createWithId(CounterScope.USER, (numericId) =>
      this.userModel.create({
        numericId,
        email: params.email.toLowerCase(),
        googleId: params.googleId,
        displayName: params.displayName ?? '',
        avatarUrl: params.avatarUrl ?? '',
        providers: [AuthProvider.GOOGLE],
        emailVerified: true,
      }),
    );
  }

  /** Attach a Google id to an existing user (signed up by email originally). */
  async linkGoogle(userId: string, googleId: string): Promise<void> {
    await this.userModel
      .updateOne(
        { _id: userId, googleId: { $in: [null, googleId] } },
        {
          $set: { googleId, emailVerified: true },
          $addToSet: { providers: AuthProvider.GOOGLE },
        },
      )
      .exec();
  }

  async markLogin(id: string): Promise<void> {
    await this.userModel.updateOne({ _id: id }, { $set: { lastLoginAt: new Date() } }).exec();
  }

  async isUsernameTaken(username: string): Promise<boolean> {
    const count = await this.userModel
      .countDocuments({ username: username.toLowerCase() })
      .exec();
    return count > 0;
  }

  async isEmailTaken(email: string): Promise<boolean> {
    const count = await this.userModel.countDocuments({ email: email.toLowerCase() }).exec();
    return count > 0;
  }

  // -------------------- Admin-side ops --------------------

  async list(params: ListUsersParams) {
    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(100, Math.max(1, params.limit ?? 20));
    const skip = (page - 1) * limit;

    const filter: FilterQuery<UserDocument> = {};
    if (params.status) filter.status = params.status;
    if (params.isHost !== undefined) filter.isHost = params.isHost;
    if (params.country) filter.country = params.country.toUpperCase();
    if (params.agencyId && Types.ObjectId.isValid(params.agencyId)) {
      filter['hostProfile.agencyId'] = new Types.ObjectId(params.agencyId);
    }
    if (params.search) {
      const escaped = params.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      const or: FilterQuery<UserDocument>[] = [
        { email: regex },
        { phone: regex },
        { username: regex },
        { displayName: regex },
      ];
      // Pure-digit search → also match numericId exactly.
      if (/^\d{1,7}$/.test(params.search.trim())) {
        or.push({ numericId: parseInt(params.search.trim(), 10) });
      }
      filter.$or = or;
    }

    const [items, total] = await Promise.all([
      this.userModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).exec(),
      this.userModel.countDocuments(filter).exec(),
    ]);

    return { items, page, limit, total };
  }

  async ban(id: string, reason: string, bannedBy?: string): Promise<UserDocument> {
    const user = await this.getByIdOrThrow(id);
    user.status = UserStatus.BANNED;
    user.banReason = reason;
    user.bannedAt = new Date();
    user.bannedBy = bannedBy ? new Types.ObjectId(bannedBy) : null;
    await user.save();
    return user;
  }

  async unban(id: string): Promise<UserDocument> {
    const user = await this.getByIdOrThrow(id);
    user.status = UserStatus.ACTIVE;
    user.banReason = '';
    user.bannedAt = null;
    user.bannedBy = null;
    await user.save();
    return user;
  }

  /**
   * Join-an-agency host promotion. Idempotent helper used by the agency
   * flows so the caller doesn't have to special-case "is the user already
   * a host?":
   *
   *   • Already a host  → only the host's `agencyId` is updated; tier /
   *     stream hours / diamond totals stay put so we don't accidentally
   *     demote a Diamond host back to Trainee when they switch agencies.
   *   • Not yet a host  → fresh `setHost(true)` at Trainee tier, with
   *     the agency baked into the new hostProfile.
   *
   * Returns the saved user document. Centralising this here keeps the
   * "joining an agency makes you a host" rule in one place instead of
   * leaking it across every entry point.
   */
  async ensureHostForAgency(
    userId: string,
    agencyId: string,
    approvedBy?: string,
  ): Promise<UserDocument> {
    const user = await this.getByIdOrThrow(userId);
    if (user.isHost) {
      const oid = Types.ObjectId.isValid(agencyId)
        ? new Types.ObjectId(agencyId)
        : null;
      // Patch the agency link without touching tier / hours / earnings.
      if (user.hostProfile) {
        user.hostProfile.agencyId = oid;
      } else {
        user.hostProfile = {
          tier: HostTier.TRAINEE,
          approvedAt: new Date(),
          approvedBy: approvedBy
            ? new Types.ObjectId(approvedBy)
            : null,
          agencyId: oid,
          totalDiamondsEarned: 0,
          streamHours: 0,
        } as any;
      }
      await user.save();
      return user;
    }
    return this.setHost(userId, true, {
      tier: HostTier.TRAINEE,
      approvedBy,
      agencyId,
    });
  }

  async setHost(
    id: string,
    makeHost: boolean,
    params?: { tier?: HostTier; approvedBy?: string; agencyId?: string | null },
  ): Promise<UserDocument> {
    const user = await this.getByIdOrThrow(id);

    if (makeHost) {
      user.isHost = true;
      user.hostProfile = {
        tier: params?.tier ?? HostTier.TRAINEE,
        approvedAt: new Date(),
        approvedBy: params?.approvedBy ? new Types.ObjectId(params.approvedBy) : null,
        agencyId:
          params?.agencyId && Types.ObjectId.isValid(params.agencyId)
            ? new Types.ObjectId(params.agencyId)
            : null,
        totalDiamondsEarned: user.hostProfile?.totalDiamondsEarned ?? 0,
        streamHours: user.hostProfile?.streamHours ?? 0,
      } as any;
    } else {
      user.isHost = false;
      // keep hostProfile for history? up to policy — we clear it for simplicity
      user.hostProfile = null;
    }

    await user.save();
    return user;
  }

  async linkAdmin(userId: string, adminId: string | null): Promise<void> {
    if (!Types.ObjectId.isValid(userId)) {
      throw new BadRequestException({ code: 'INVALID_USER_ID', message: 'Invalid user id' });
    }
    await this.userModel
      .updateOne(
        { _id: userId },
        { $set: { linkedAdminId: adminId ? new Types.ObjectId(adminId) : null } },
      )
      .exec();
  }

  /**
   * Replace the user's `agencyPowers` array. Drives the mobile app's
   * "Management" section visibility — when this list is non-empty, the
   * section becomes visible on the user's profile.
   *
   * Known powers:
   *   • `agency.create` — can found a new agency from the mobile app
   *   • `agency.manage` — moderator override across every agency
   *
   * The caller already validated against the permissions catalog; we
   * just store whatever array was passed. De-duped + filtered to drop
   * blank strings so a stray UI bug can't smuggle nonsense in.
   */
  async setAgencyPowers(userId: string, powers: string[]): Promise<UserDocument> {
    if (!Types.ObjectId.isValid(userId)) {
      throw new BadRequestException({
        code: 'INVALID_USER_ID',
        message: 'Invalid user id',
      });
    }
    const clean = Array.from(
      new Set(powers.map((p) => p.trim()).filter((p) => p.length > 0)),
    );
    const user = await this.userModel
      .findByIdAndUpdate(
        userId,
        { $set: { agencyPowers: clean } },
        { new: true },
      )
      .exec();
    if (!user) {
      throw new NotFoundException({
        code: 'USER_NOT_FOUND',
        message: 'User not found',
      });
    }
    return user;
  }

  // -------------------- Profile (user-facing) --------------------

  async updateProfile(
    id: string,
    update: Partial<{
      displayName: string;
      bio: string;
      language: string;
      country: string;
      username: string;
      gender: UserGender;
      dateOfBirth: string;
    }>,
  ): Promise<UserDocument> {
    const user = await this.getByIdOrThrow(id);

    if (update.username !== undefined && update.username !== user.username) {
      const lower = update.username.toLowerCase();
      if (await this.isUsernameTaken(lower)) {
        throw new BadRequestException({
          code: 'USERNAME_TAKEN',
          message: 'Username already taken',
        });
      }
      user.username = lower;
    }
    if (update.displayName !== undefined) user.displayName = update.displayName;
    if (update.bio !== undefined) user.bio = update.bio;
    if (update.language !== undefined) user.language = update.language;
    const previousCountry = user.country;
    if (update.country !== undefined) user.country = update.country.toUpperCase();
    if (update.gender !== undefined) user.gender = update.gender;
    if (update.dateOfBirth !== undefined) {
      // DTO already validated as ISO date string. Reject obviously
      // bogus values up here so a malformed string can't slip past
      // and become a NaN-Date in storage.
      const parsed = new Date(update.dateOfBirth);
      if (Number.isNaN(parsed.getTime())) {
        throw new BadRequestException({
          code: 'INVALID_DOB',
          message: 'Invalid date of birth',
        });
      }
      user.dateOfBirth = parsed;
    }

    await user.save();

    // Country change → sync the denormalized `Room.ownerCountry` on
    // every room this user owns. Done via the Room model directly
    // rather than via RoomsService to avoid a UsersModule→RoomsModule
    // import cycle (UsersModule has no need to know about anything
    // else from RoomsModule). Failure here doesn't roll back the user
    // save — the room boot-time backfill catches stale rows on the
    // next deploy, and the home filter just shows the room one click
    // late until then. Logged so it's visible.
    if (
      update.country !== undefined &&
      user.country !== previousCountry
    ) {
      try {
        await this.roomModel
          .updateMany(
            { ownerId: user._id },
            { $set: { ownerCountry: user.country } },
          )
          .exec();
      } catch (err) {
        this.logger.warn(
          `Room.ownerCountry sync for ${user._id} failed: ${(err as Error).message}`,
        );
      }
    }
    return user;
  }

  async setAvatar(id: string, url: string, publicId: string): Promise<UserDocument> {
    const user = await this.getByIdOrThrow(id);
    user.avatarUrl = url;
    user.avatarPublicId = publicId;
    await user.save();
    return user;
  }

  async setCoverPhoto(id: string, url: string, publicId: string): Promise<UserDocument> {
    const user = await this.getByIdOrThrow(id);
    user.coverPhotoUrl = url;
    user.coverPhotoPublicId = publicId;
    await user.save();
    return user;
  }

  // -------------------- Account deletion (user-initiated) --------------------

  /**
   * Soft-deletes the current user's account in line with the in-app
   * "Delete Account" flow required by the Play Store.
   *
   * What happens:
   *   • status → DELETED (auth.assertActive rejects login afterwards).
   *   • PII fields (email, phone, username, googleId, facebookId, appleId,
   *     dateOfBirth, passwordHash) are $unset so the sparse-unique
   *     indexes free up and the same Google account can register fresh.
   *   • displayName → "Deleted User", avatar/cover/bio cleared so any
   *     legacy references to this userId render anonymously.
   *   • All FCM device tokens for this user are dropped — push stops
   *     immediately and the next sign-in on the same handset registers
   *     a new (user, device) row.
   *
   * Intentionally NOT done here:
   *   • Hard delete of the user document (numericId references in
   *     transactions/rooms/family rosters would dangle).
   *   • Cascade on transactions / financial records — kept for tax /
   *     audit obligations (see Refund Policy).
   *   • Cloudinary asset cleanup — handled in the controller next to
   *     the existing MediaService dependency, so this method has no
   *     external-side-effects of its own.
   *
   * Returns the snapshot taken BEFORE the anonymisation so the caller
   * (controller) can clean up media using the original public IDs.
   */
  async softDeleteAccount(userId: string): Promise<{
    avatarPublicId: string;
    coverPhotoPublicId: string;
  }> {
    const user = await this.getByIdOrThrow(userId);
    if (user.status === UserStatus.DELETED) {
      throw new BadRequestException({
        code: 'ALREADY_DELETED',
        message: 'Account is already deleted',
      });
    }

    const snapshot = {
      avatarPublicId: user.avatarPublicId ?? '',
      coverPhotoPublicId: user.coverPhotoPublicId ?? '',
    };

    await this.userModel
      .updateOne(
        { _id: user._id },
        {
          $set: {
            status: UserStatus.DELETED,
            displayName: 'Deleted User',
            bio: '',
            avatarUrl: '',
            avatarPublicId: '',
            coverPhotoUrl: '',
            coverPhotoPublicId: '',
            providers: [],
            emailVerified: false,
            phoneVerified: false,
            isHost: false,
            hostProfile: null,
          },
          $unset: {
            email: '',
            phone: '',
            username: '',
            googleId: '',
            facebookId: '',
            appleId: '',
            passwordHash: '',
            dateOfBirth: '',
          },
        },
      )
      .exec();

    // Drop all push-token rows for this user. Keeps notifications from
    // landing on a phone whose user just deleted their account, and frees
    // the (token) unique index so the device can re-register cleanly
    // under a new sign-in.
    const fcmRes = await this.deviceTokenModel
      .deleteMany({ userId: user._id })
      .exec();

    this.logger.log(
      `User ${userId} soft-deleted; removed ${fcmRes.deletedCount ?? 0} FCM tokens`,
    );

    return snapshot;
  }

  /**
   * Strips fields that should never be exposed via public profile lookups
   * (other users viewing this user). Owner-side endpoints return the raw doc.
   */
  toPublic(user: UserDocument): Record<string, unknown> {
    const json = user.toJSON() as Record<string, any>;
    delete json.email;
    delete json.phone;
    delete json.providers;
    delete json.emailVerified;
    delete json.phoneVerified;
    delete json.lastLoginAt;
    delete json.banReason;
    delete json.bannedAt;
    delete json.bannedBy;
    delete json.linkedAdminId;
    return json;
  }
}
