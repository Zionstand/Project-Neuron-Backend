import { Module } from '@nestjs/common';
import { OversightController } from './oversight.controller';
import { OversightService } from './oversight.service';
import { SchoolsModule } from '../schools/schools.module';
import { SessionsModule } from '../sessions/sessions.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [SchoolsModule, SessionsModule, NotificationsModule],
  controllers: [OversightController],
  providers: [OversightService],
})
export class OversightModule {}
