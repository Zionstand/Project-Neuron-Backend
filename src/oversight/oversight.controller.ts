import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/roles.guard';
import { Roles } from '../common/roles.decorator';
import { CAN_READ_INSPECTIONS, CAN_VIEW_RISK } from '../common/roles.constants';
import { OversightService } from './oversight.service';
import { SectionDto, FlagMediaDto } from './dto/verify.dto';

type SectionKey = 'asc' | 'students' | 'staff' | 'security' | 'media';

// Supervisor / admin oversight (ZONAL_COORD, EMIS_OFFICER, HOD_APPROVE,
// SYS_ADMIN). Geographic scope is applied in the service (RBAC Rule 3).
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...CAN_READ_INSPECTIONS)
@Controller('oversight')
export class OversightController {
  constructor(private readonly oversight: OversightService) {}

  @Get('submissions')
  submissions(
    @Req() req: any,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.oversight.listSubmissions(req.user, { page, pageSize });
  }

  // Risk is aggregated (no PII) — also visible to EXEC_VIEW, who cannot verify.
  @Roles(...CAN_VIEW_RISK)
  @Get('risk')
  risk(
    @Req() req: any,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('tier') tier?: string,
  ) {
    return this.oversight.riskOverview(req.user, { page, pageSize, tier });
  }

  // Full security dataset as CSV. Unlike /risk this carries the individual
  // answers, so it stays on the verifier roles rather than CAN_VIEW_RISK, and
  // the download is recorded — a file of school vulnerabilities leaving the
  // system is worth being able to account for later.
  @Get('export/security.csv')
  async exportSecurity(
    @Req() req: any,
    @Res({ passthrough: true }) res: Response,
    @Query('periodId') periodId?: string,
  ) {
    const { csv, filename, rows } = await this.oversight.securityExport(
      req.user,
      periodId,
    );
    await this.oversight.recordExport(req.user, filename, rows);
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      // The browser must not hold a copy of this in a shared cache.
      'Cache-Control': 'no-store',
    });
    return new StreamableFile(Buffer.from(csv, 'utf-8'));
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

  // Supervisor flags a media file for review (or unflags with an empty reason).
  @Post('schools/:id/media/:mediaId/flag')
  flagMedia(
    @Req() req: any,
    @Param('id') id: string,
    @Param('mediaId') mediaId: string,
    @Body() dto: FlagMediaDto,
  ) {
    return this.oversight.flagMedia(req.user, id, mediaId, dto.reason);
  }
}
