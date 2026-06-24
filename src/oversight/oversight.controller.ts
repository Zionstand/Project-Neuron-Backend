import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/roles.guard';
import { Roles } from '../common/roles.decorator';
import { CAN_READ_INSPECTIONS, CAN_VIEW_RISK } from '../common/roles.constants';
import { OversightService } from './oversight.service';
import { SectionDto } from './dto/verify.dto';

type SectionKey = 'asc' | 'students' | 'staff' | 'security' | 'media';

// Supervisor / admin oversight (ZONAL_COORD, EMIS_OFFICER, HOD_APPROVE,
// SYS_ADMIN). Geographic scope is applied in the service (RBAC Rule 3).
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...CAN_READ_INSPECTIONS)
@Controller('oversight')
export class OversightController {
  constructor(private readonly oversight: OversightService) {}

  @Get('submissions')
  submissions(@Req() req: any) {
    return this.oversight.listSubmissions(req.user);
  }

  // Risk is aggregated (no PII) — also visible to EXEC_VIEW, who cannot verify.
  @Roles(...CAN_VIEW_RISK)
  @Get('risk')
  risk(@Req() req: any) {
    return this.oversight.riskOverview(req.user);
  }

  @Post('schools/:id/verify')
  verify(@Req() req: any, @Param('id') id: string, @Body() dto: SectionDto) {
    return this.oversight.verify(req.user, id, dto.section as SectionKey);
  }

  @Post('schools/:id/return')
  returnForRevision(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: SectionDto,
  ) {
    return this.oversight.returnForRevision(req.user, id, dto.section as SectionKey);
  }
}
