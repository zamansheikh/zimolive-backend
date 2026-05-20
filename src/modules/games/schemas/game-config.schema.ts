import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type GameConfigDocument = HydratedDocument<GameConfig>;

/**
 * One config doc per game (keyed by short slug like `fruits_loop`).
 * Holds the wheel item list + multipliers + RTP target + bet tiers
 * + currency + per-round timing. Admin can edit any of these without
 * a redeploy; the round runner re-reads the doc each round so
 * changes take effect from the NEXT round (in-flight rounds keep
 * their original config to avoid mid-round mutation surprises).
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
export class GameConfig {
  /** Short slug, e.g. `fruits_loop`. Unique. Used as the realtime
   *  scope (`game:<gameKey>`), the URL path on the web app
   *  (`<gamesBaseUrl>/<gameKey>/`), and the deeplink path
   *  (`/games/:gameKey`). Must match the folder name in
   *  `zimolive-games/<gameKey>/`. Lowercase + underscores; no
   *  spaces / hyphens. */
  @Prop({ type: String, required: true, unique: true })
  gameKey!: string;

  /** Discriminator for the round-engine behaviour. Today only
   *  `wheel_betting` exists; future card / dice / slot games can
   *  register additional kinds without changing the schema. The
   *  service picks an engine implementation off this field at
   *  round-open time. */
  @Prop({
    type: String,
    enum: ['wheel_betting'],
    default: 'wheel_betting',
    required: true,
  })
  kind!: 'wheel_betting';

  /** Human-readable title shown on the lobby tile, the web app
   *  header, and the admin list. */
  @Prop({ type: String, required: true })
  title!: string;

  /** One-line tagline for the lobby tile. Empty string is allowed
   *  — the tile then renders the title alone. */
  @Prop({ type: String, default: '' })
  description!: string;

  /** Square icon (~96×96) shown on the lobby tile and the game
   *  header. Empty string falls back to a placeholder gradient on
   *  the mobile side. */
  @Prop({ type: String, default: '' })
  iconUrl!: string;

  /** Wide hero image (~3:2) shown above the title on the lobby
   *  tile when present. Empty string just hides the hero. */
  @Prop({ type: String, default: '' })
  bannerUrl!: string;

  /** Lobby section label. Free-form so admins can group similar
   *  games (e.g. "Wheel", "Cards", "Featured"). Empty string
   *  means "uncategorised" — the lobby groups those under a
   *  default heading. */
  @Prop({ type: String, default: '' })
  category!: string;

  /** Ascending sort key for the lobby. Tiles with the same value
   *  fall back to alphabetical-by-title. Allows admins to pin
   *  hot games at the top without renaming. */
  @Prop({ type: Number, default: 100 })
  sortOrder!: number;

  /** Whether the round runner is allowed to schedule new rounds for
   *  this game AND whether it appears in the lobby. Flip false to
   *  hide the game from players AND pause the loop (in-flight
   *  round finishes; no next round opens). */
  @Prop({ type: Boolean, default: true })
  enabled!: boolean;

  /** Wheel items + payout multipliers. Order matters — the index in
   *  this array is also the wheel slot index on the UI. */
  @Prop({
    type: [
      {
        key: { type: String, required: true },
        label: { type: String, required: true },
        multiplier: { type: Number, required: true, min: 1 },
        _id: false,
      },
    ],
    required: true,
  })
  items!: Array<{ key: string; label: string; multiplier: number }>;

  /** Allowed bet chip values. UI renders them in order; the
   *  server validates incoming bets against this list. */
  @Prop({ type: [Number], required: true })
  betTiers!: number[];

  /** Target return-to-player percentage, 0..100. Drives the
   *  RTP-bounded winner selection — the server picks an item whose
   *  payout to current bettors stays within this cap. */
  @Prop({ type: Number, required: true, min: 1, max: 100, default: 70 })
  rtpPercent!: number;

  /** Currency used for bets + payouts. `coins` (in-app spend
   *  currency) is the default; `diamonds` if the game pays out the
   *  host-earning currency directly. */
  @Prop({ type: String, enum: ['coins', 'diamonds'], default: 'coins' })
  currency!: 'coins' | 'diamonds';

  /** Round timings in milliseconds. */
  @Prop({ type: Number, default: 30_000 })
  bettingMs!: number;

  @Prop({ type: Number, default: 5_000 })
  spinMs!: number;

  /** Pause between the result reveal and the next round opening —
   *  gives the UI time to settle and pays a moment of "winner
   *  showcase" attention before chips reset. */
  @Prop({ type: Number, default: 5_000 })
  intermissionMs!: number;
}

export const GameConfigSchema = SchemaFactory.createForClass(GameConfig);
