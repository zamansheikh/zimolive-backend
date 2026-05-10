import { Global, Module } from '@nestjs/common';

import { ContentFilterService } from './content-filter.service';

/**
 * Cross-cutting moderation utilities. Currently exposes only
 * `ContentFilterService`, used by every UGC ingest path (room chat,
 * DMs, moments) to vet text before it hits the database.
 *
 * Marked `@Global()` so consuming modules don't have to import this
 * module in their `imports[]` — they can just inject the service.
 * That avoids the cycle risk we already hit once between
 * UsersModule / RoomsModule / MessagesModule.
 */
@Global()
@Module({
  providers: [ContentFilterService],
  exports: [ContentFilterService],
})
export class ModerationModule {}
