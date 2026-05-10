import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type AppConfigDocument = HydratedDocument<AppConfig>;

/**
 * Singleton system config — only ever ONE document in this collection,
 * looked up by the canonical `_singleton` key. Stores feature toggles and
 * other admin-tunable settings that need to survive without redeploys.
 *
 * Add new flags here as they're needed; the API surface is generic so it
 * doesn't have to grow alongside.
 */
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
export class AppConfig {
  /** Always 'singleton' — used as the lookup key for upsert. */
  @Prop({ type: String, required: true, unique: true, default: 'singleton' })
  key!: string;

  /**
   * Whether the user-facing family feature is on. When false:
   *   - mobile clients hide the families UI
   *   - backend rejects family create / join requests
   * Existing families are preserved.
   */
  @Prop({ type: Boolean, default: true })
  familiesEnabled!: boolean;

  /**
   * Whether the agency feature is on. When false:
   *   - admin can no longer create agencies or assign hosts
   *   - mobile clients hide agency-related UI
   * Existing agencies are preserved.
   */
  @Prop({ type: Boolean, default: true })
  agenciesEnabled!: boolean;

  /**
   * Whether email + password login is exposed in the mobile app. The
   * BACKEND endpoints (`/auth/register/email`, `/auth/login/email`)
   * remain available regardless — this flag only controls UI exposure
   * so we can stage rollouts without dropping in-flight sessions.
   *
   * Default false: launch with Google / Apple Sign-In only, enable
   * email later if needed.
   */
  @Prop({ type: Boolean, default: false })
  emailLoginEnabled!: boolean;

  /**
   * Whether phone-OTP login is exposed in the mobile app. Same shape
   * as `emailLoginEnabled` — backend `/auth/otp/send` + `/auth/otp/verify`
   * stay available; this only hides the UI when off.
   *
   * Default false: lots of regions where SMS deliverability is
   * unreliable and we don't want to ship a broken-looking flow.
   */
  @Prop({ type: Boolean, default: false })
  phoneLoginEnabled!: boolean;
}

export const AppConfigSchema = SchemaFactory.createForClass(AppConfig);
// `key` is already indexed via `@Prop({ unique: true })`.
