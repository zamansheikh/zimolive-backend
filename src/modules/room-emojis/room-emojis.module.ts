import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { MediaModule } from '../media/media.module';
import { RealtimeModule } from '../realtime/realtime.module';
import {
  RoomSeat,
  RoomSeatSchema,
} from '../rooms/schemas/room-seat.schema';
import { RoomEmojisAdminController } from './room-emojis-admin.controller';
import { RoomEmojisController } from './room-emojis.controller';
import { RoomEmojisService } from './room-emojis.service';
import {
  RoomEmoji,
  RoomEmojiSchema,
} from './schemas/room-emoji.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: RoomEmoji.name, schema: RoomEmojiSchema },
      { name: RoomSeat.name, schema: RoomSeatSchema },
    ]),
    MediaModule,
    RealtimeModule,
  ],
  controllers: [RoomEmojisController, RoomEmojisAdminController],
  providers: [RoomEmojisService],
  exports: [RoomEmojisService],
})
export class RoomEmojisModule {}
