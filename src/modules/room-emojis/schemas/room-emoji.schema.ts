import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type RoomEmojiDocument = HydratedDocument<RoomEmoji>;

/**
 * What kind of asset drives the visual:
 *
 *   • `char`  — raw unicode character (e.g. "😀"). Renders via plain Text
 *               on the client; no network hit, smallest payload.
 *   • `image` — static image URL (PNG / WEBP / GIF). Cached on the
 *               client.
 *   • `svga`  — animated SVGA URL. Played via SVGAEasyPlayer. Heaviest
 *               but the only option for fancy multi-frame reactions.
 */
export enum RoomEmojiType {
  CHAR = 'char',
  IMAGE = 'image',
  SVGA = 'svga',
}

@Schema({
  timestamps: true,
  toJSON: {
    transform: (_doc, ret: Record<string, any>) => {
      ret.id = ret._id?.toString();
      delete ret._id;
      delete ret.__v;
      return ret;
    },
  },
})
export class RoomEmoji {
  /** Display name (e.g. "Laughing", "X-eyes"). i18n is left for later. */
  @Prop({ type: String, required: true, maxlength: 60 })
  name!: string;

  /** Free-form bucket for the picker tabs (e.g. "happy", "sad", "tease",
   *  "love", "vip"). The mobile picker groups by this string. */
  @Prop({ type: String, default: 'general', maxlength: 40, index: true })
  category!: string;

  @Prop({ type: String, enum: RoomEmojiType, required: true, index: true })
  type!: RoomEmojiType;

  /** Required when `type` is `image` or `svga`. Cloudinary URL. */
  @Prop({ type: String, default: '', maxlength: 500 })
  assetUrl!: string;

  /** Cloudinary public id, kept for cleanup on update / delete. */
  @Prop({ type: String, default: '', maxlength: 200 })
  assetPublicId!: string;

  /** Required when `type` is `char`. Raw unicode character(s). */
  @Prop({ type: String, default: '', maxlength: 8 })
  char!: string;

  /** How long the reaction stays on screen, in milliseconds. Server
   *  ships this in the realtime payload; clients schedule the dismiss
   *  off this value so we can tune visibility centrally. */
  @Prop({ type: Number, default: 3000, min: 500, max: 15000 })
  durationMs!: number;

  /** Soft-delete flag. Inactive emojis are kept in the catalog but hidden
   *  from the public list. */
  @Prop({ type: Boolean, default: true, index: true })
  active!: boolean;

  /** Sort order in the picker. Lower first; ties broken by createdAt. */
  @Prop({ type: Number, default: 0, index: true })
  sortOrder!: number;
}

export const RoomEmojiSchema = SchemaFactory.createForClass(RoomEmoji);
