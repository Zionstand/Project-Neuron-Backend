import { Module } from '@nestjs/common';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';
import { CapturePeriodService } from './capture-period.service';

@Module({
  controllers: [SessionsController],
  providers: [SessionsService, CapturePeriodService],
  exports: [SessionsService],
})
export class SessionsModule {}
