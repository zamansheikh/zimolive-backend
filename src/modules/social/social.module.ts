import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { HonorsModule } from '../honors/honors.module';
import { User, UserSchema } from '../users/schemas/user.schema';
import { Follow, FollowSchema } from './schemas/follow.schema';
import {
  ProfileVisit,
  ProfileVisitSchema,
} from './schemas/profile-visit.schema';
import { SocialController } from './social.controller';
import { SocialService } from './social.service';

/**
 * Social graph + profile-view tracking. Registered as its own module
 * so the user-controller and rooms paths don't grow unrelated
 * follow / visitor logic. We register the User schema via
 * `forFeature` (NOT importing UsersModule) because we only need
 * direct Mongoose access for the denormalized counters; importing
 * UsersModule would close a follow → users → rooms chain that has
 * already bitten us once.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Follow.name, schema: FollowSchema },
      { name: ProfileVisit.name, schema: ProfileVisitSchema },
      { name: User.name, schema: UserSchema },
    ]),
    // Follow / unfollow fires honor evaluations for the FOLLOWERS
    // and FOLLOWING metrics so reach-N-friends medals auto-unlock.
    HonorsModule,
  ],
  controllers: [SocialController],
  providers: [SocialService],
  exports: [SocialService],
})
export class SocialModule {}
