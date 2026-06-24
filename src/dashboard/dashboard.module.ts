import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { SchoolsModule } from '../schools/schools.module';
import { SessionsModule } from '../sessions/sessions.module';

@Module({
  imports: [SchoolsModule, SessionsModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
