import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { User, UserSchema } from '../users/schemas/user.schema';
import { MomentsAdminController } from './moments-admin.controller';
import { MomentsController } from './moments.controller';
import { MomentsService } from './moments.service';
import {
  MomentComment,
  MomentCommentSchema,
} from './schemas/moment-comment.schema';
import { MomentLike, MomentLikeSchema } from './schemas/moment-like.schema';
import { Moment, MomentSchema } from './schemas/moment.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Moment.name, schema: MomentSchema },
      { name: MomentLike.name, schema: MomentLikeSchema },
      { name: MomentComment.name, schema: MomentCommentSchema },
      // Read-only access to User for hydrating recent-reactor previews
      // on the feed. Full UsersModule isn't imported to avoid coupling.
      { name: User.name, schema: UserSchema },
    ]),
  ],
  controllers: [MomentsController, MomentsAdminController],
  providers: [MomentsService],
  exports: [MomentsService],
})
export class MomentsModule {}
