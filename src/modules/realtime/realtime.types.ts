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

  /** Room was closed by the host (or auto-closed when the host left
   *  a video room). Payload: `{ reason: 'host_left' | 'closed_by_host' }`.
   *  Receivers should pop the room page + show a short toast. */
  ROOM_CLOSED = 'room.closed',

  /** Chat message posted in this room. Payload is the persisted message
   *  with author hydrated. */
  ROOM_CHAT_MESSAGE = 'room.chat.message',

  /** Owner / admin wiped the room's chat scrollback. Payload:
   *  `{ clearedBy: string, clearedAt: string }` — receivers drop their
   *  local scrollback so every member sees a fresh chat. The persisted
   *  messages are flagged `REMOVED` server-side, so a refetch returns
   *  an empty list. */
  ROOM_CHAT_CLEANED = 'room.chat.cleaned',

  /** Gift sent in this room — drives the SVGA overlay + banner. */
  ROOM_GIFT_SENT = 'room.gift.sent',

  /** Host or admin invited a user to a specific seat. The payload
   *  carries the target userId; receivers filter client-side and only
   *  the target shows the accept/reject prompt. */
  SEAT_INVITED = 'seat.invited',

  /** A viewer fired a request to join the host's stage as an audio
   *  caller (host-broadcast mode only). Sent to the entire room so
   *  the host's manage-calls badge updates live and other admins see
   *  the queue too. Payload: full CallRequest JSON with `requester`
   *  hydrated (id, username, displayName, avatarUrl). */
  CALL_REQUEST_CREATED = 'call_request.created',

  /** A pending call request was resolved (approved, denied, canceled
   *  by the requester, or expired). Receivers drop it from their
   *  local list. Payload: `{ requestId, roomId, userId, status }`
   *  where status is one of `'approved' | 'denied' | 'canceled' | 'expired'`. */
  CALL_REQUEST_RESOLVED = 'call_request.resolved',

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

  // ---------- Wheel-betting games (scope: `game:<gameKey>`) ----------
  /** A new betting round has opened. Payload carries the full
   *  round snapshot (items + timings) so a client subscribing
   *  mid-round can paint without a separate fetch. */
  GAME_ROUND_STARTED = 'game.round.started',
  /** A bet just landed. Payload: `{ item, amount, betsByItem, betCount, totalBet }`.
   *  Drives the live chip-stack visualisation on the wheel — we
   *  echo aggregates so the UI never has to fan out per-user. */
  GAME_BET_PLACED = 'game.bet.placed',
  /** Betting closed for the current round; spin animation starts.
   *  Payload: `{ winningItem, spinEndsAt }`. The winning item is
   *  broadcast HERE (not in the result event) so the wheel
   *  animation lands on the right slot — clients use the
   *  remaining spin duration to drive the rotation. */
  GAME_ROUND_SPINNING = 'game.round.spinning',
  /** Spin animation ended; payouts have been credited. Payload:
   *  `{ winningItem, totalPayout, winners: [{ userId, amount, payout }] }`.
   *  Clients use this to flash winnings + update history. */
  GAME_ROUND_RESULT = 'game.round.result',

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
