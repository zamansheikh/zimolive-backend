import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type AgencyJoinRequestDocument = HydratedDocument<AgencyJoinRequest>;

export enum AgencyJoinRequestStatus {
  /** Submitted by the user, waiting for owner / admin decision. */
  PENDING = 'pending',
  /** Owner / admin accepted — the AgencyMember row is created in the
   *  same transaction the approval runs in. */
  APPROVED = 'approved',
  /** Owner / admin rejected. The user can re-apply after a cooldown. */
  REJECTED = 'rejected',
  /** User cancelled their own request before a decision was made. */
  CANCELLED = 'cancelled',
}

/**
 * One row per agency-join attempt. Survives approval / rejection so the
 * agency can keep an audit trail of decisions ("who let so-and-so in",
 * "who rejected X twice this week"). A user can have at most one
 * PENDING row per agency at a time — service guards this.
 */
@Schema({
  timestamps: true,
  toJSON: {
    transform: (_doc, ret: Record<string, any>) => {
      ret.id = ret._id?.toString();
      ret.agencyId = ret.agencyId?.toString();
      ret.userId = ret.userId?.toString();
      ret.decidedBy = ret.decidedBy?.toString();
      delete ret._id;
      delete ret.__v;
      return ret;
    },
  },
})
export class AgencyJoinRequest {
  @Prop({ type: Types.ObjectId, ref: 'Agency', required: true, index: true })
  agencyId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId!: Types.ObjectId;

  @Prop({
    type: String,
    enum: AgencyJoinRequestStatus,
    default: AgencyJoinRequestStatus.PENDING,
    index: true,
  })
  status!: AgencyJoinRequestStatus;

  /** Free-form pitch the applicant writes ("I stream music 3 hrs/day"). */
  @Prop({ type: String, default: '', maxlength: 500 })
  message!: string;

  /** Owner / admin who approved or rejected. Null while pending. */
  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  decidedBy?: Types.ObjectId | null;

  @Prop({ type: Date, default: null })
  decidedAt?: Date | null;

  /** Optional reason the owner / admin gave for the decision. */
  @Prop({ type: String, default: '', maxlength: 500 })
  decisionNote!: string;
}

export const AgencyJoinRequestSchema =
  SchemaFactory.createForClass(AgencyJoinRequest);
// At most one pending row per (agency, user). Old finalized rows are
// excluded from the unique guard via a partial filter expression so the
// audit trail can keep them around.
AgencyJoinRequestSchema.index(
  { agencyId: 1, userId: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: { status: AgencyJoinRequestStatus.PENDING },
  },
);
AgencyJoinRequestSchema.index({ agencyId: 1, status: 1, createdAt: -1 });
AgencyJoinRequestSchema.index({ userId: 1, createdAt: -1 });
