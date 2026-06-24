import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/roles.guard';
import { Roles } from '../common/roles.decorator';
import { CAN_MANAGE_USERS } from '../common/roles.constants';
import { UsersService } from './users.service';
import {
  ProvisionUserDto,
  ApproveUserDto,
  RejectUserDto,
  UpdateUserDto,
  StatusActionDto,
} from './dto/user.dto';

// SYS_ADMIN-only user administration (RBAC Rule 6, CAN_MANAGE_USERS).
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...CAN_MANAGE_USERS)
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list(
    @Query('status') status?: string,
    @Query('role') role?: string,
    @Query('q') q?: string,
  ) {
    return this.users.list({ status, role, q });
  }

  @Get('pending-count')
  pendingCount() {
    return this.users.pendingCount();
  }

  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.users.getOne(id);
  }

  @Post()
  provision(@Req() req: any, @Body() dto: ProvisionUserDto) {
    return this.users.provision(req.user.id, dto);
  }

  @Patch(':id/approve')
  approve(@Req() req: any, @Param('id') id: string, @Body() dto: ApproveUserDto) {
    return this.users.approve(req.user.id, id, dto);
  }

  @Patch(':id/reject')
  reject(@Req() req: any, @Param('id') id: string, @Body() dto: RejectUserDto) {
    return this.users.reject(req.user.id, id, dto);
  }

  @Patch(':id/role')
  updateRole(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.users.updateRoleScope(req.user.id, id, dto);
  }

  @Patch(':id/status')
  changeStatus(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: StatusActionDto,
  ) {
    return this.users.changeStatus(req.user.id, id, dto);
  }

  @Post(':id/reset-password')
  resetPassword(@Req() req: any, @Param('id') id: string) {
    return this.users.resetPassword(req.user.id, id);
  }
}
