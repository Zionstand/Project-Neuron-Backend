import { Module } from '@nestjs/common';
import { SchoolsController } from './schools.controller';
import { SchoolsService } from './schools.service';
import { RegistersController } from './registers.controller';
import { RegistersService } from './registers.service';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { AdminSchoolsController } from './admin-schools.controller';
import { AdminSchoolsService } from './admin-schools.service';
import { SessionsModule } from '../sessions/sessions.module';

@Module({
  imports: [SessionsModule],
  controllers: [
    SchoolsController,
    RegistersController,
    MediaController,
    AdminSchoolsController,
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
