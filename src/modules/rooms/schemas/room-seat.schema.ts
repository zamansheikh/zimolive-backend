import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type RoomSeatDocument = HydratedDocument<RoomSeat>;

function refToId(v: unknown): unknown {
  if (v == null) return v;
  if (v instanceof Types.ObjectId) return v.toString();
  return v;
}

/**
 * One row per seat slot in a room. Seats are pre-created on room creation so
 * the realtime layer can address them by `(roomId, seatIndex)` without
 * worrying about whether the row exists yet.
 *
 * `seatIndex` 0 is reserved for the owner's center mic; 1..micCount are the
 * guest seats laid out in the grid.
 */
@Schema({
  timestamps: true,
  toJSON: {
    transform: (_doc, ret: Record<string, any>) => {
      ret.id = ret._id?.toString();
      ret.roomId = refToId(ret.roomId);
      ret.userId = refToId(ret.userId);
      delete ret._id;
      delete ret.__v;
      return ret;
    },
  },
})
export class RoomSeat {
  @Prop({ type: Types.ObjectId, ref: 'Room', required: true, index: true })
  roomId!: Types.ObjectId;

  @Prop({ type: Number, required: true, min: 0, max: 15 })
  seatIndex!: number;

  /** null = empty seat. */
  @Prop({ type: Types.ObjectId, ref: 'User', default: null, index: true })
  userId?: Types.ObjectId | null;

  /** Locked seats can't be taken by anyone except an admin invite. */
  @Prop({ type: Boolean, default: false })
  locked!: boolean;

  /**
   * Effective mute state — covers both self-mute (user tapped their mic
   * button) and host-mute (owner/admin force-muted the seat). Drives the
   * mic-off badge that everyone in the room sees over the seat tile.
   * When `muted=false`, the seat is publishing audio (subject to Agora
   * permissions etc.).
   */
  @Prop({ type: Boolean, default: false })
  muted!: boolean;

  /**
   * Who muted this seat — only meaningful when `muted=true`.
   *
   *   • `self`  — the seat-holder muted themselves with the mic button.
   *   • `host`  — owner or an admin force-muted the seat. Self-unmute is
   *               blocked while this is the cause; the seat-holder must
   *               wait for a host to lift it.
   *   • `null`  — seat is unmuted (or was never muted).
   *
   * Cleared back to `null` whenever `muted` flips to false.
   */
  @Prop({ type: String, enum: ['self', 'host', null], default: null })
  mutedBy!: 'self' | 'host' | null;

  /**
   * True when this seat is currently publishing video.
   *
   *   • audio rooms — always false (the field exists so the seat shape
   *     stays uniform across kinds).
   *   • video / hostBroadcast — only seat 0 (owner) ever flips true;
   *     guest seats stay false (audio-only callers).
   *   • video / multiSeat — defaults to true when a user takes the
   *     seat; can be toggled via `POST /rooms/:id/seats/:i/video`.
   */
  @Prop({ type: Boolean, default: false })
  videoEnabled!: boolean;

  @Prop({ type: Date, default: null })
  joinedAt?: Date | null;
}

export const RoomSeatSchema = SchemaFactory.createForClass(RoomSeat);
RoomSeatSchema.index({ roomId: 1, seatIndex: 1 }, { unique: true });
RoomSeatSchema.index({ roomId: 1, userId: 1 });
