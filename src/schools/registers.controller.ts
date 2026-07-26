import {
  Body,
  Controller,
  Delete,
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
import { RegistersService } from './registers.service';
import { BatchBodyPipe, type BatchBody } from '../common/batch-body.pipe';
import {
  AscRecordDto,
  StudentRecordDto,
  StaffRecordDto,
} from './dto/register.dto';

// Register-type capture endpoints, nested under a school. Coarse role gate here;
// LGA/zone scoping is enforced in the service (RBAC Rule 3).
//
// Each POST takes either one record or an array of them, so a device draining an
// offline queue makes one request instead of one per row. The response mirrors
// the request shape: an object in, an object out; an array in, an array out.
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('schools/:id')
export class RegistersController {
  constructor(private readonly registers: RegistersService) {}

  // ─── Annual School Census ───────────────────────────────────────────────────
  @Roles(...CAN_READ_SCHOOL_REGISTRY)
  @Get('asc')
  listAsc(@Req() req: any, @Param('id') id: string) {
    return this.registers.listAsc(req.user, id);
  }

  @Roles(...CAN_SUBMIT_INSPECTION)
  @Post('asc')
  async createAsc(
    @Req() req: any,
    @Param('id') id: string,
    @Body(new BatchBodyPipe(AscRecordDto)) body: BatchBody<AscRecordDto>,
  ) {
    const rows = await this.registers.createAsc(req.user, id, body.items);
    return body.single ? rows[0] : rows;
  }

  @Roles(...CAN_SUBMIT_INSPECTION)
  @Post('asc/submit')
  submitAsc(@Req() req: any, @Param('id') id: string) {
    return this.registers.submitAsc(req.user, id);
  }

  @Roles(...CAN_SUBMIT_INSPECTION)
  @Put('asc/:rowId')
  updateAsc(
    @Req() req: any,
    @Param('id') id: string,
    @Param('rowId') rowId: string,
    @Body() dto: AscRecordDto,
  ) {
    return this.registers.updateAsc(req.user, id, rowId, dto);
  }

  @Roles(...CAN_SUBMIT_INSPECTION)
  @Delete('asc/:rowId')
  removeAsc(
    @Req() req: any,
    @Param('id') id: string,
    @Param('rowId') rowId: string,
  ) {
    return this.registers.removeAsc(req.user, id, rowId);
  }

  // ─── Students ────────────────────────────────────────────────────────────────
  @Roles(...CAN_READ_SCHOOL_REGISTRY)
  @Get('students')
  listStudents(@Req() req: any, @Param('id') id: string) {
    return this.registers.listStudents(req.user, id);
  }

  @Roles(...CAN_SUBMIT_INSPECTION)
  @Post('students')
  async createStudent(
    @Req() req: any,
    @Param('id') id: string,
    @Body(new BatchBodyPipe(StudentRecordDto)) body: BatchBody<StudentRecordDto>,
  ) {
    const rows = await this.registers.createStudent(req.user, id, body.items);
    return body.single ? rows[0] : rows;
  }

  @Roles(...CAN_SUBMIT_INSPECTION)
  @Post('students/submit')
  submitStudents(@Req() req: any, @Param('id') id: string) {
    return this.registers.submitStudents(req.user, id);
  }

  @Roles(...CAN_SUBMIT_INSPECTION)
  @Put('students/:rowId')
  updateStudent(
    @Req() req: any,
    @Param('id') id: string,
    @Param('rowId') rowId: string,
    @Body() dto: StudentRecordDto,
  ) {
    return this.registers.updateStudent(req.user, id, rowId, dto);
  }

  @Roles(...CAN_SUBMIT_INSPECTION)
  @Delete('students/:rowId')
  removeStudent(
    @Req() req: any,
    @Param('id') id: string,
    @Param('rowId') rowId: string,
  ) {
    return this.registers.removeStudent(req.user, id, rowId);
  }

  // ─── Staff ───────────────────────────────────────────────────────────────────
  @Roles(...CAN_READ_SCHOOL_REGISTRY)
  @Get('staff')
  listStaff(@Req() req: any, @Param('id') id: string) {
    return this.registers.listStaff(req.user, id);
  }

  @Roles(...CAN_SUBMIT_INSPECTION)
  @Post('staff')
  async createStaff(
    @Req() req: any,
    @Param('id') id: string,
    @Body(new BatchBodyPipe(StaffRecordDto)) body: BatchBody<StaffRecordDto>,
  ) {
    const rows = await this.registers.createStaff(req.user, id, body.items);
    return body.single ? rows[0] : rows;
  }

  @Roles(...CAN_SUBMIT_INSPECTION)
  @Post('staff/submit')
  submitStaff(@Req() req: any, @Param('id') id: string) {
    return this.registers.submitStaff(req.user, id);
  }

  @Roles(...CAN_SUBMIT_INSPECTION)
  @Put('staff/:rowId')
  updateStaff(
    @Req() req: any,
    @Param('id') id: string,
    @Param('rowId') rowId: string,
    @Body() dto: StaffRecordDto,
  ) {
    return this.registers.updateStaff(req.user, id, rowId, dto);
  }

  @Roles(...CAN_SUBMIT_INSPECTION)
  @Delete('staff/:rowId')
  removeStaff(
    @Req() req: any,
    @Param('id') id: string,
    @Param('rowId') rowId: string,
  ) {
    return this.registers.removeStaff(req.user, id, rowId);
  }
}
