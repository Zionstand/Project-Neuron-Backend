import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/roles.guard';
import { Roles } from '../common/roles.decorator';
import {
  CAN_READ_SCHOOL_REGISTRY,
  CAN_SUBMIT_INSPECTION,
} from '../common/roles.constants';
import { SchoolsService } from './schools.service';
import { SecurityAssessmentDto } from './dto/security-assessment.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('schools')
export class SchoolsController {
  constructor(private readonly schoolsService: SchoolsService) {}

  // The LIE worklist: schools in the caller's scope plus capture status for the
  // current session. Role gate is coarse (registry readers); LGA/zone scoping is
  // applied in the service (RBAC Rule 3).
  @Roles(...CAN_READ_SCHOOL_REGISTRY)
  @Get()
  list(@Req() req: any) {
    return this.schoolsService.listForUser(req.user);
  }

  // School master record + current-session visit + security assessment.
  @Roles(...CAN_READ_SCHOOL_REGISTRY)
  @Get(':id')
  detail(@Req() req: any, @Param('id') id: string) {
    return this.schoolsService.getDetail(req.user, id);
  }

  // Save the security & vulnerability assessment as a draft (partial allowed).
  @Roles(...CAN_SUBMIT_INSPECTION)
  @Put(':id/security')
  saveSecurity(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: SecurityAssessmentDto,
  ) {
    return this.schoolsService.saveSecurity(req.user, id, dto);
  }

  // Validate required fields, compute risk scores, and mark SUBMITTED.
  @Roles(...CAN_SUBMIT_INSPECTION)
  @Post(':id/security/submit')
  submitSecurity(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: SecurityAssessmentDto,
  ) {
    return this.schoolsService.submitSecurity(req.user, id, dto);
  }
}
