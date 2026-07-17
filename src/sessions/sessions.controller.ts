import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/roles.guard';
import { Roles } from '../common/roles.decorator';
import { CAN_MANAGE_REFERENCE_DATA } from '../common/roles.constants';
import { SessionsService } from './sessions.service';
import { CapturePeriodService } from './capture-period.service';
import { CreateSessionDto, UpdateSessionDto } from './dto/session.dto';
import {
  CreateCapturePeriodDto,
  UpdateCapturePeriodDto,
} from './dto/capture-period.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('sessions')
export class SessionsController {
  constructor(
    private readonly sessionsService: SessionsService,
    private readonly periods: CapturePeriodService,
  ) {}

  // Any authenticated user needs the current session for capture.
  @Get('current')
  getCurrent() {
    return this.sessionsService.getCurrentOrThrow();
  }

  // Any authenticated user needs the current capture period (for the capture UI).
  @Get('periods/current')
  getCurrentPeriod() {
    return this.sessionsService.getCurrentPeriodOrThrow();
  }

  // ─── Admin (reference data) ─────────────────────────────────────────────────
  @Roles(...CAN_MANAGE_REFERENCE_DATA)
  @Get()
  list() {
    return this.sessionsService.listAll();
  }

  @Roles(...CAN_MANAGE_REFERENCE_DATA)
  @Post()
  create(@Body() dto: CreateSessionDto) {
    return this.sessionsService.create(dto);
  }

  @Roles(...CAN_MANAGE_REFERENCE_DATA)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateSessionDto) {
    return this.sessionsService.update(id, dto);
  }

  @Roles(...CAN_MANAGE_REFERENCE_DATA)
  @Patch(':id/activate')
  activate(@Param('id') id: string) {
    return this.sessionsService.activate(id);
  }

  // ─── Capture periods (rounds within a session) ──────────────────────────────
  @Roles(...CAN_MANAGE_REFERENCE_DATA)
  @Get(':sessionId/periods')
  listPeriods(@Param('sessionId') sessionId: string) {
    return this.periods.listForSession(sessionId);
  }

  @Roles(...CAN_MANAGE_REFERENCE_DATA)
  @Post(':sessionId/periods')
  createPeriod(
    @Param('sessionId') sessionId: string,
    @Body() dto: CreateCapturePeriodDto,
  ) {
    return this.periods.create(sessionId, dto);
  }

  @Roles(...CAN_MANAGE_REFERENCE_DATA)
  @Patch('periods/:id')
  updatePeriod(
    @Param('id') id: string,
    @Body() dto: UpdateCapturePeriodDto,
  ) {
    return this.periods.update(id, dto);
  }

  @Roles(...CAN_MANAGE_REFERENCE_DATA)
  @Patch('periods/:id/activate')
  activatePeriod(@Param('id') id: string) {
    return this.periods.activate(id);
  }
}
