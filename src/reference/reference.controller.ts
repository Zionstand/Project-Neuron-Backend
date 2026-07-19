import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/roles.guard';
import { Roles } from '../common/roles.decorator';
import {
  CAN_MANAGE_REFERENCE_DATA,
  CAN_READ_SCHOOL_REGISTRY,
} from '../common/roles.constants';
import { ReferenceService } from './reference.service';
import {
  CreateReferenceDto,
  UpdateReferenceDto,
  REFERENCE_KINDS,
  type ReferenceKind,
} from './dto/reference.dto';

function assertKind(kind: string): ReferenceKind {
  if (!(REFERENCE_KINDS as readonly string[]).includes(kind)) {
    throw new BadRequestException('Unknown reference type.');
  }
  return kind as ReferenceKind;
}

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('reference')
export class ReferenceController {
  constructor(private readonly reference: ReferenceService) {}

  // Read — any capture user needs these to populate dropdowns. PRINCIPAL included
  // via CAN_READ_SCHOOL_REGISTRY.
  @Roles(...CAN_READ_SCHOOL_REGISTRY)
  @Get(':kind')
  list(@Param('kind') kind: string, @Query('all') all?: string) {
    // Admins can pass ?all=1 to include inactive rows for management.
    return this.reference.list(assertKind(kind), all !== '1');
  }

  // ─── Admin CRUD (SYS_ADMIN) ─────────────────────────────────────────────────
  @Roles(...CAN_MANAGE_REFERENCE_DATA)
  @Post(':kind')
  create(@Param('kind') kind: string, @Body() dto: CreateReferenceDto) {
    return this.reference.create(assertKind(kind), dto);
  }

  @Roles(...CAN_MANAGE_REFERENCE_DATA)
  @Patch(':kind/:id')
  update(
    @Param('kind') kind: string,
    @Param('id') id: string,
    @Body() dto: UpdateReferenceDto,
  ) {
    return this.reference.update(assertKind(kind), id, dto);
  }
}
