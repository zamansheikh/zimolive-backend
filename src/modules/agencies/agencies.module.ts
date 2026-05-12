import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AdminAuthModule } from '../admin/admin-auth/admin-auth.module';
import { SystemConfigModule } from '../system-config/system-config.module';
import { User, UserSchema } from '../users/schemas/user.schema';
import { UsersModule } from '../users/users.module';
import { AgenciesController } from './agencies.controller';
import { AgenciesService } from './agencies.service';
import { AppAgenciesController } from './app-agencies.controller';
import { AppAgenciesService } from './app-agencies.service';
import {
  AgencyJoinRequest,
  AgencyJoinRequestSchema,
} from './schemas/agency-join-request.schema';
import {
  AgencyMember,
  AgencyMemberSchema,
} from './schemas/agency-member.schema';
import { Agency, AgencySchema } from './schemas/agency.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Agency.name, schema: AgencySchema },
      { name: AgencyMember.name, schema: AgencyMemberSchema },
      { name: AgencyJoinRequest.name, schema: AgencyJoinRequestSchema },
      // The app-facing service reads / writes `User.agencyPowers` and
      // exposes hydrated user info on the roster / requests responses.
      // We bring User in directly instead of going through UsersModule
      // to avoid a circular dep that the admin-facing service already
      // breaks via `UsersModule`.
      { name: User.name, schema: UserSchema },
    ]),
    UsersModule,
    SystemConfigModule,
    AdminAuthModule,
  ],
  controllers: [AgenciesController, AppAgenciesController],
  providers: [AgenciesService, AppAgenciesService],
  exports: [AgenciesService, AppAgenciesService],
})
export class AgenciesModule {}
