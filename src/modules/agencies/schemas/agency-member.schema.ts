import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type AgencyMemberDocument = HydratedDocument<AgencyMember>;

/**
 * Role of an app user inside their agency. Distinct from the admin-side
 * `AdminUser` "agency" scope — those are platform admins assigned to manage
 * an agency from the admin panel. Members below sit inside the mobile app:
 *
 *   • owner  — exactly one per agency. Full control: rename, approve / kick,
 *              promote / demote, transfer ownership. Created on agency
 *              create.
 *   • admin  — promoted by the owner. Can approve / reject join requests
 *              and kick members. Cannot rename / disband / promote / demote.
 *   • member — default. Read-only view of the roster + own stats.
 *
 * One row per (agencyId, userId). Joining a different agency requires
 * leaving the current one first.
 */
export enum AgencyMemberRole {
  OWNER = 'owner',
  ADMIN = 'admin',
  MEMBER = 'member',
}

@Schema({
  timestamps: true,
  toJSON: {
    transform: (_doc, ret: Record<string, any>) => {
      ret.id = ret._id?.toString();
      ret.agencyId = ret.agencyId?.toString();
      ret.userId = ret.userId?.toString();
      delete ret._id;
      delete ret.__v;
      return ret;
    },
  },
})
export class AgencyMember {
  @Prop({ type: Types.ObjectId, ref: 'Agency', required: true, index: true })
  agencyId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId!: Types.ObjectId;

  @Prop({
    type: String,
    enum: AgencyMemberRole,
    default: AgencyMemberRole.MEMBER,
    index: true,
  })
  role!: AgencyMemberRole;

  @Prop({ type: Date, default: () => new Date() })
  joinedAt!: Date;

  /**
   * Denormalized lifetime contribution counter — bumped when the member's
   * room receives gifts. Drives the agency ranking page without a join /
   * aggregate. Source of truth is `transactions`; the value here is
   * eventually consistent.
   */
  @Prop({ type: Number, default: 0 })
  diamondsContributed!: number;

  /** Total minutes the member has spent live, mirrored from LiveSession. */
  @Prop({ type: Number, default: 0 })
  liveMinutes!: number;
}

export const AgencyMemberSchema = SchemaFactory.createForClass(AgencyMember);
// One row per (agency, user) — a user can be in at most one agency at a
// time. Soft-quit + re-join is handled by upsert in the service.
AgencyMemberSchema.index({ agencyId: 1, userId: 1 }, { unique: true });
AgencyMemberSchema.index({ userId: 1 }, { unique: true });
AgencyMemberSchema.index({ agencyId: 1, diamondsContributed: -1 });
