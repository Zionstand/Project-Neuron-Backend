import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/roles.guard';
import { Roles } from '../common/roles.decorator';
import { CAN_VIEW_DASHBOARD } from '../common/roles.constants';
import { DashboardService } from './dashboard.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  // The field-capture home for LIE and INSPECT_OFFICER (cluster-scoped).
  // SYS_ADMIN is allowed through for support/testing.
  @Roles('LIE', 'INSPECT_OFFICER', 'SYS_ADMIN')
  @Get('lie/summary')
  lieSummary(@Req() req: any) {
    return this.dashboardService.lieSummary(req.user);
  }

  // State-wide overview for admins / leadership (aggregated only — no PII).
  @Roles(...CAN_VIEW_DASHBOARD)
  @Get('admin/summary')
  adminSummary(@Req() req: any) {
    return this.dashboardService.adminSummary(req.user);
  }
}
