import { Module } from '@nestjs/common';
import { SchoolsController } from './schools.controller';
import { SchoolsService } from './schools.service';
import { RegistersController } from './registers.controller';
import { RegistersService } from './registers.service';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { AdminSchoolsController } from './admin-schools.controller';
import { AdminSchoolsService } from './admin-schools.service';
import { PublicSchoolsController } from './public-schools.controller';
import { SessionsModule } from '../sessions/sessions.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [SessionsModule, NotificationsModule],
  controllers: [
    SchoolsController,
    RegistersController,
    MediaController,
    AdminSchoolsController,
    PublicSchoolsController,
  ],
  providers: [
    SchoolsService,
    RegistersService,
    MediaService,
    AdminSchoolsService,
  ],
  exports: [SchoolsService],
})
export class SchoolsModule {}
