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
import { CreateSessionDto, UpdateSessionDto } from './dto/session.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessionsService: SessionsService) {}

  // Any authenticated user needs the current session for capture.
  @Get('current')
  getCurrent() {
    return this.sessionsService.getCurrentOrThrow();
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
}
