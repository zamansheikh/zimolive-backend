import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type UserDocument = HydratedDocument<User>;

export enum UserStatus {
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
  BANNED = 'banned',
  DELETED = 'deleted',
}

export enum UserGender {
  MALE = 'male',
  FEMALE = 'female',
  OTHER = 'other',
}

export enum AuthProvider {
  EMAIL = 'email',
  PHONE = 'phone',
  GOOGLE = 'google',
  FACEBOOK = 'facebook',
  APPLE = 'apple',
}

export enum HostTier {
  TRAINEE = 'trainee',
  BRONZE = 'bronze',
  SILVER = 'silver',
  GOLD = 'gold',
  PLATINUM = 'platinum',
  DIAMOND = 'diamond',
}

@Schema({ _id: false })
export class HostProfile {
  @Prop({ type: String, enum: HostTier, default: HostTier.TRAINEE })
  tier!: HostTier;

  @Prop({ type: Date, default: () => new Date() })
  approvedAt!: Date;

  @Prop({ type: Types.ObjectId, default: null })
  approvedBy?: Types.ObjectId | null;

  /** Agency that this host is signed with, if any. */
  @Prop({ type: Types.ObjectId, default: null })
  agencyId?: Types.ObjectId | null;

  @Prop({ type: Number, default: 0 })
  totalDiamondsEarned!: number;

  @Prop({ type: Number, default: 0 })
  streamHours!: number;
}

export const HostProfileSchema = SchemaFactory.createForClass(HostProfile);

@Schema({
  timestamps: true,
  toJSON: {
    virtuals: true,
    transform: (_doc, ret: Record<string, any>) => {
      ret.id = ret._id?.toString();
      // Server-computed signal the mobile app uses to gate the
      // home screen behind the post-signup profile-completion form.
      // True only when the three required onboarding fields are set.
      // Country has a legacy default ('BD') so we treat any non-empty
      // string as filled; gender + dateOfBirth must be explicit.
      ret.profileComplete = Boolean(
        ret.gender &&
          ret.dateOfBirth &&
          typeof ret.country === 'string' &&
          ret.country.length > 0,
      );
      delete ret._id;
      delete ret.__v;
      delete ret.passwordHash;
      return ret;
    },
  },
})
export class User {
  /**
   * 7-digit public ID (1_000_000+), separate from the Mongo ObjectId. Users
   * see and search by this; partners use it as the user-facing handle.
   * Sparse so legacy rows from before the rollout can coexist until the
   * backfill migration assigns one.
   */
  @Prop({ type: Number, unique: true, sparse: true, index: true })
  numericId?: number;

  @Prop({ type: String, lowercase: true, trim: true, sparse: true, unique: true })
  email?: string;

  @Prop({ type: String, trim: true, sparse: true, unique: true })
  phone?: string;

  @Prop({ type: String, lowercase: true, trim: true, sparse: true, unique: true })
  username?: string;

  @Prop({ type: String, select: false })
  passwordHash?: string;

  @Prop({ type: [String], enum: AuthProvider, default: [] })
  providers!: AuthProvider[];

  /** Google subject id (the `sub` claim of the verified ID token). */
  @Prop({ type: String, default: null, sparse: true, index: true })
  googleId?: string | null;

  /** Facebook user id (when we add Facebook OAuth). */
  @Prop({ type: String, default: null, sparse: true, index: true })
  facebookId?: string | null;

  /** Apple sub id (for Sign In with Apple). */
  @Prop({ type: String, default: null, sparse: true, index: true })
  appleId?: string | null;

  @Prop({ type: String, default: '' })
  displayName!: string;

  @Prop({ type: String, default: '' })
  avatarUrl!: string;

  /** Cloudinary public_id for the avatar — needed to overwrite/delete it later. */
  @Prop({ type: String, default: '' })
  avatarPublicId!: string;

  @Prop({ type: String, default: '' })
  coverPhotoUrl!: string;

  @Prop({ type: String, default: '' })
  coverPhotoPublicId!: string;

  @Prop({ type: String, default: '' })
  bio!: string;

  @Prop({ type: String, default: 'en' })
  language!: string;

  @Prop({ type: String, default: 'BD' })
  country!: string;

  /** Self-declared at the post-signup profile-completion step. Optional
   *  in the schema so legacy users (created before this field existed)
   *  don't break, but required by the profile-complete gate before the
   *  user reaches the home screen. ISO-style enum keeps the value space
   *  bounded; richer identities can be expressed via display name. */
  @Prop({ type: String, enum: UserGender, default: null })
  gender?: UserGender | null;

  /** Self-declared birth date. Stored as a Date so age can be derived
   *  consistently regardless of when the value is read. The mobile
   *  picker enforces a 13+ minimum at submit; schema-level validation
   *  is intentionally absent so we can lower/raise the cutoff later
   *  without a migration. Treated as filled if non-null. */
  @Prop({ type: Date, default: null })
  dateOfBirth?: Date | null;

  @Prop({ type: String, enum: UserStatus, default: UserStatus.ACTIVE })
  status!: UserStatus;

  @Prop({ type: String, default: '' })
  banReason!: string;

  @Prop({ type: Date, default: null })
  bannedAt?: Date | null;

  @Prop({ type: Types.ObjectId, default: null })
  bannedBy?: Types.ObjectId | null;

  @Prop({ type: Boolean, default: false })
  emailVerified!: boolean;

  @Prop({ type: Boolean, default: false })
  phoneVerified!: boolean;

  /** Denormalized social-graph counts. The follow / unfollow service
   *  bumps these atomically with the corresponding Follow row insert /
   *  delete so the public-profile endpoint can return them in O(1)
   *  without a `countDocuments` per request. Visitor count lives on
   *  the social side too (not denormalized — computed on the
   *  visitors-list endpoint, which is rare). */
  @Prop({ type: Number, default: 0 })
  followersCount!: number;

  @Prop({ type: Number, default: 0 })
  followingCount!: number;

  @Prop({ type: Date })
  lastLoginAt?: Date;

  @Prop({ type: Number, default: 1 })
  level!: number;

  @Prop({ type: Number, default: 0 })
  xp!: number;

  // ------- Host capability (user becomes a broadcaster) -------

  @Prop({ type: Boolean, default: false, index: true })
  isHost!: boolean;

  @Prop({ type: HostProfileSchema, default: null })
  hostProfile?: HostProfile | null;

  // ------- Admin linkage (if user was promoted to agency/reseller) -------

  @Prop({ type: Types.ObjectId, ref: 'AdminUser', default: null, index: true })
  linkedAdminId?: Types.ObjectId | null;

  // ------- Agency-management powers (app-side) -------
  //
  // Granted by a platform admin from the admin panel. Drives the
  // "Management Power" section on the user's profile in the mobile
  // app: when this list is non-empty, the section becomes visible
  // and the matching tiles route into the agency-management UI.
  //
  // Stored as plain strings so admins can grant a subset (e.g. only
  // `agency.create`) without flipping a binary "is admin?" flag.
  // Examples:
  //   • 'agency.create'  — can found a new agency from the mobile app
  //   • 'agency.manage'  — can manage any agency they own / co-own
  //
  // Membership-derived powers (owner / admin role on a specific
  // agency) are NOT stored here — those live on `AgencyMember.role`
  // so a user who quits the agency loses them automatically.
  @Prop({ type: [String], default: [] })
  agencyPowers!: string[];
}

export const UserSchema = SchemaFactory.createForClass(User);

// email/phone/username/numericId are already indexed via their @Prop
// `unique: true, sparse: true` — re-declaring here triggers Mongoose
// duplicate-index warnings on every boot.
UserSchema.index({ createdAt: -1 });
UserSchema.index({ status: 1 });
UserSchema.index({ isHost: 1, status: 1 });
