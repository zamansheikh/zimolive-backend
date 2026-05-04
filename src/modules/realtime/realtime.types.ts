/**
 * Server-to-client event vocabulary for the realtime gateway. Every event
 * carries a monotonic `seq` so the client can detect gaps and request a
 * replay over the same channel.
 *
 * Two scopes:
 *   - room:<roomId>  — only members currently in the room receive these
 *   - global         — every connected user receives these (rocket banner,
 *                      maintenance banners, system pings)
 *
 * Add a new type only after the receiver knows how to render an unknown
 * type as a no-op; clients newer than the server will see types the
 * server isn't emitting yet, and vice versa.
 */
export enum RealtimeEventType {
  // ---------- Room-scoped ----------
  /** Seat ownership/lock/mute changed. Payload: full RoomSeat JSON. */
  SEAT_UPDATED = 'seat.updated',

  /** Room settings (name, announcement, micCount, theme, policies). */
  ROOM_SETTINGS_UPDATED = 'room.settings.updated',

  /** Forced room-wide event: someone was kicked/blocked. */
  ROOM_USER_BLOCKED = 'room.user.blocked',

  /** Member presence change (joined / left). */
  ROOM_MEMBER_JOINED = 'room.member.joined',
  ROOM_MEMBER_LEFT = 'room.member.left',

  /** Chat message posted in this room. Payload is the persisted message
   *  with author hydrated. */
  ROOM_CHAT_MESSAGE = 'room.chat.message',

  /** Gift sent in this room — drives the SVGA overlay + banner. */
  ROOM_GIFT_SENT = 'room.gift.sent',

  /** Host or admin invited a user to a specific seat. The payload
   *  carries the target userId; receivers filter client-side and only
   *  the target shows the accept/reject prompt. */
  SEAT_INVITED = 'seat.invited',

  /** A rocket has filled in this room and is launching now. */
  ROOM_ROCKET_LAUNCH = 'room.rocket.launch',

  /** Live energy progress while a rocket is filling. Fired on every
   *  successful gift contribution so the in-room fuel gauge animates
   *  without a full state refetch. Payload:
   *  `{ roomId, level, currentEnergy, energyRequired, status }`. */
  ROOM_ROCKET_FUEL = 'room.rocket.fuel',

  /** A user dropped a Lucky Bag in this room. Payload: full LuckyBag
   *  document (sender hydrated). All members render the floating card +
   *  countdown; once `availableAt` passes, taps open the claim flow. */
  ROOM_LUCKY_BAG_SENT = 'room.lucky_bag.sent',

  /** Someone claimed a slot from a Lucky Bag in this room. Payload:
   *  `{ bagId, slotIndex, claimerId, amount, slotsTaken, slotCount }`.
   *  Lets every other member tick their progress badge and, when
   *  `slotsTaken === slotCount`, retire the floating card. */
  ROOM_LUCKY_BAG_CLAIMED = 'room.lucky_bag.claimed',

  /** A seated user fired an emoji reaction over their seat tile.
   *  Payload:
   *  `{ seatIndex, userId, emoji: { id, name, type, assetUrl?, char? }, durationMs }`.
   *  Receivers render the emoji as a transient overlay on the matching
   *  seat for `durationMs` (default ~3s). Only seated users can fire; the
   *  service rejects others with `NOT_SEATED`. Coalesces to the latest
   *  reaction per seat — a fast double-tap replaces the prior overlay. */
  ROOM_SEAT_EMOJI = 'room.seat.emoji',

  // ---------- Global ----------
  /** A rocket fired somewhere on the platform — banner everyone sees. */
  GLOBAL_ROCKET_BANNER = 'global.rocket.banner',

  /** A Lucky Bag was just dropped somewhere on the platform — surface a
   *  top-of-screen banner so users can hop into the room and try to
   *  catch a slot. Payload: `{ bagId, roomId, roomName, sender, totalCoins, slotCount }`. */
  GLOBAL_LUCKY_BAG_BANNER = 'global.lucky_bag.banner',

  /** Free-form announcement banner from admin. */
  GLOBAL_ANNOUNCEMENT = 'global.announcement',

  // ---------- User-scoped (1-1 messaging) ----------
  /** A 1-1 message landed for this user. Sent to BOTH participants on
   *  their respective `user:<id>` scopes — the recipient updates their
   *  inbox + thread, the sender's other devices stay in sync. Payload:
   *  `{ message, conversation }`. */
  MESSAGE_RECEIVED = 'message.received',

  /** This user marked a conversation read on some device — the others
   *  should clear the badge locally. Payload: `{ conversationId }`. */
  MESSAGE_READ = 'message.read',

  /** A new notification landed in this user's inbox. Sent only to the
   *  recipient's `user:<id>` scope. Payload: `{ notification }`. */
  NOTIFICATION_RECEIVED = 'notification.received',

  /** This user marked one (or all) notifications read on some device.
   *  Payload: `{ id }` where `id` is a notification id or the literal
   *  string `"all"` for mark-all-read. */
  NOTIFICATION_READ = 'notification.read',
}

export interface RealtimeEvent<TPayload = unknown> {
  /** Monotonic across this scope (room or global). Set by the server. */
  seq: number;
  /** Scope this event is bound to: `room:<roomId>` or `global`. */
  scope: string;
  type: RealtimeEventType;
  payload: TPayload;
  /** ISO timestamp the server emitted at. */
  at: string;
}
