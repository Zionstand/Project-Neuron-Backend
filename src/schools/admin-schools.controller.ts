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
import { CAN_MANAGE_REFERENCE_DATA } from '../common/roles.constants';
import { AdminSchoolsService } from './admin-schools.service';
import {
  CreateSchoolDto,
  UpdateSchoolDto,
  SetActiveDto,
  ImportSchoolsDto,
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
  ) {
    return this.schools.list({ lga, q, active, cluster });
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
}
