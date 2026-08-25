import {
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
  CAN_READ_INSPECTIONS,
} from '../common/roles.constants';
import { AdminSchoolsService } from './admin-schools.service';
import {
  CreateSchoolDto,
  UpdateSchoolDto,
  SetActiveDto,
  ImportSchoolsDto,
  GpsVerifyDto,
} from './dto/admin-school.dto';

// School registry administration (reference data, SYS_ADMIN). Separate path
// prefix from the LIE-facing /schools worklist to avoid route collisions.
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...CAN_MANAGE_REFERENCE_DATA)
@Controller('admin/schools')
export class AdminSchoolsController {
  constructor(private readonly schools: AdminSchoolsService) {}

  @Get()
  list(
    @Query('lga') lga?: string,
    @Query('q') q?: string,
    @Query('active') active?: string,
    @Query('cluster') cluster?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.schools.list({ lga, q, active, cluster, page, pageSize });
  }

  // Full record: capture history, bound principal, GPS provenance, data volumes.
  @Get(':id/detail')
  getDetail(@Param('id') id: string) {
    return this.schools.getDetail(id);
  }

  @Post()
  create(@Body() dto: CreateSchoolDto) {
    return this.schools.create(dto);
  }

  @Post('import')
  import(@Body() dto: ImportSchoolsDto) {
    return this.schools.import(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateSchoolDto) {
    return this.schools.update(id, dto);
  }

  @Patch(':id/active')
  setActive(@Param('id') id: string, @Body() dto: SetActiveDto) {
    return this.schools.setActive(id, dto.isActive);
  }

  // Supervisor sign-off on a captured GPS location (Field Capture Guide §1.4).
  // Overrides the class role gate — verifiers, not just SYS_ADMIN.
  @Roles(...CAN_READ_INSPECTIONS)
  @Patch(':id/gps-verify')
  gpsVerify(@Param('id') id: string, @Body() dto: GpsVerifyDto) {
    return this.schools.setGpsVerified(id, dto.gpsVerified);
  }
}
