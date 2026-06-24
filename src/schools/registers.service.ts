import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from '../sessions/sessions.service';
import { SchoolsService, type RequestUser } from './schools.service';
import { CaptureStatus, Gender } from '../generated/prisma/client';
import {
  AscRecordDto,
  StudentRecordDto,
  StaffRecordDto,
} from './dto/register.dto';

const toDate = (v?: string | null) => (v ? new Date(v) : null);

@Injectable()
export class RegistersService {
  constructor(
    private prisma: PrismaService,
    private sessions: SessionsService,
    private schools: SchoolsService,
  ) {}

  // Common preamble: confirm scope, resolve the current session, ensure the
  // visit row exists. Returns the session id.
  private async prepare(user: RequestUser, schoolId: string) {
    await this.schools.requireScopedSchool(user, schoolId);
    const session = await this.sessions.getCurrentOrThrow();
    await this.schools.ensureVisit(schoolId, session.id, user.id);
    return session;
  }

  private async sessionScope(user: RequestUser, schoolId: string) {
    await this.schools.requireScopedSchool(user, schoolId);
    return this.sessions.findCurrent();
  }

  // Recompute a register's section status from its row count (NOT_STARTED when
  // empty, DRAFT otherwise) and roll it into the visit.
  private async refreshSection(
    schoolId: string,
    sessionId: string,
    inspectorId: string,
    field: 'ascStatus' | 'studentsStatus' | 'staffStatus',
    count: number,
  ) {
    const visit = await this.schools.ensureVisit(
      schoolId,
      sessionId,
      inspectorId,
    );
    await this.schools.setSectionStatus(
      visit.id,
      field,
      count > 0 ? CaptureStatus.DRAFT : CaptureStatus.NOT_STARTED,
    );
  }

  private duplicate(message: string) {
    return new ConflictException(message);
  }

  // ─── ASC ───────────────────────────────────────────────────────────────────

  async listAsc(user: RequestUser, schoolId: string) {
    const session = await this.sessionScope(user, schoolId);
    const rows = session
      ? await this.prisma.ascRecord.findMany({
          where: { schoolId, sessionId: session.id },
          orderBy: [{ classLevel: 'asc' }, { gender: 'asc' }],
        })
      : [];
    return { session, rows, status: await this.sectionStatus(schoolId, session, 'ascStatus') };
  }

  async createAsc(user: RequestUser, schoolId: string, dto: AscRecordDto) {
    if (dto.newEntrants > dto.enrolmentCount) {
      throw new BadRequestException(
        'New entrants cannot exceed the enrolment count.',
      );
    }
    const session = await this.prepare(user, schoolId);
    try {
      const row = await this.prisma.ascRecord.create({
        data: {
          schoolId,
          sessionId: session.id,
          collectedById: user.id,
          classLevel: dto.classLevel,
          gender: dto.gender as Gender,
          enrolmentCount: dto.enrolmentCount,
          newEntrants: dto.newEntrants,
          repeaters: dto.repeaters,
          dropoutCount: dto.dropoutCount,
        },
      });
      await this.bumpAsc(schoolId, session.id, user.id);
      return row;
    } catch (e: any) {
      if (e?.code === 'P2002')
        throw this.duplicate(
          `${dto.classLevel} ${dto.gender} has already been recorded for this school.`,
        );
      throw e;
    }
  }

  async updateAsc(
    user: RequestUser,
    schoolId: string,
    rowId: string,
    dto: AscRecordDto,
  ) {
    if (dto.newEntrants > dto.enrolmentCount) {
      throw new BadRequestException(
        'New entrants cannot exceed the enrolment count.',
      );
    }
    const session = await this.prepare(user, schoolId);
    await this.ownedRow('ascRecord', rowId, schoolId, session.id);
    try {
      const row = await this.prisma.ascRecord.update({
        where: { id: rowId },
        data: {
          classLevel: dto.classLevel,
          gender: dto.gender as Gender,
          enrolmentCount: dto.enrolmentCount,
          newEntrants: dto.newEntrants,
          repeaters: dto.repeaters,
          dropoutCount: dto.dropoutCount,
        },
      });
      await this.bumpAsc(schoolId, session.id, user.id);
      return row;
    } catch (e: any) {
      if (e?.code === 'P2002')
        throw this.duplicate(
          `${dto.classLevel} ${dto.gender} has already been recorded for this school.`,
        );
      throw e;
    }
  }

  async removeAsc(user: RequestUser, schoolId: string, rowId: string) {
    const session = await this.prepare(user, schoolId);
    await this.ownedRow('ascRecord', rowId, schoolId, session.id);
    await this.prisma.ascRecord.delete({ where: { id: rowId } });
    await this.bumpAsc(schoolId, session.id, user.id);
    return { message: 'Record removed.' };
  }

  async submitAsc(user: RequestUser, schoolId: string) {
    const session = await this.prepare(user, schoolId);
    const count = await this.prisma.ascRecord.count({
      where: { schoolId, sessionId: session.id },
    });
    if (count === 0) {
      throw new BadRequestException(
        'Add at least one class enrolment row before submitting.',
      );
    }
    const visit = await this.schools.ensureVisit(schoolId, session.id, user.id);
    await this.schools.setSectionStatus(
      visit.id,
      'ascStatus',
      CaptureStatus.SUBMITTED,
    );
    return { message: 'Annual School Census submitted.' };
  }

  private async bumpAsc(schoolId: string, sessionId: string, userId: string) {
    const count = await this.prisma.ascRecord.count({
      where: { schoolId, sessionId },
    });
    await this.refreshSection(schoolId, sessionId, userId, 'ascStatus', count);
  }

  // ─── Students ────────────────────────────────────────────────────────────────

  async listStudents(user: RequestUser, schoolId: string) {
    const session = await this.sessionScope(user, schoolId);
    const rows = session
      ? await this.prisma.studentRecord.findMany({
          where: { schoolId, sessionId: session.id },
          orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
        })
      : [];
    return {
      session,
      rows,
      status: await this.sectionStatus(schoolId, session, 'studentsStatus'),
    };
  }

  async createStudent(
    user: RequestUser,
    schoolId: string,
    dto: StudentRecordDto,
  ) {
    const session = await this.prepare(user, schoolId);
    try {
      const row = await this.prisma.studentRecord.create({
        data: { schoolId, sessionId: session.id, collectedById: user.id, ...this.studentData(dto) },
      });
      await this.bumpStudents(schoolId, session.id, user.id);
      return row;
    } catch (e: any) {
      if (e?.code === 'P2002')
        throw this.duplicate(
          `A student with code "${dto.studentCode}" already exists for this school.`,
        );
      throw e;
    }
  }

  async updateStudent(
    user: RequestUser,
    schoolId: string,
    rowId: string,
    dto: StudentRecordDto,
  ) {
    const session = await this.prepare(user, schoolId);
    await this.ownedRow('studentRecord', rowId, schoolId, session.id);
    try {
      const row = await this.prisma.studentRecord.update({
        where: { id: rowId },
        data: this.studentData(dto),
      });
      await this.bumpStudents(schoolId, session.id, user.id);
      return row;
    } catch (e: any) {
      if (e?.code === 'P2002')
        throw this.duplicate(
          `A student with code "${dto.studentCode}" already exists for this school.`,
        );
      throw e;
    }
  }

  async removeStudent(user: RequestUser, schoolId: string, rowId: string) {
    const session = await this.prepare(user, schoolId);
    await this.ownedRow('studentRecord', rowId, schoolId, session.id);
    await this.prisma.studentRecord.delete({ where: { id: rowId } });
    await this.bumpStudents(schoolId, session.id, user.id);
    return { message: 'Student removed.' };
  }

  async submitStudents(user: RequestUser, schoolId: string) {
    const session = await this.prepare(user, schoolId);
    const count = await this.prisma.studentRecord.count({
      where: { schoolId, sessionId: session.id },
    });
    if (count === 0) {
      throw new BadRequestException(
        'Add at least one student before submitting.',
      );
    }
    const visit = await this.schools.ensureVisit(schoolId, session.id, user.id);
    await this.schools.setSectionStatus(
      visit.id,
      'studentsStatus',
      CaptureStatus.SUBMITTED,
    );
    return { message: 'Student register submitted.' };
  }

  private studentData(dto: StudentRecordDto) {
    return {
      studentCode: dto.studentCode,
      classLevel: dto.classLevel,
      firstName: dto.firstName,
      middleName: dto.middleName ?? null,
      lastName: dto.lastName,
      dateOfBirth: toDate(dto.dateOfBirth),
      gender: dto.gender as Gender,
      stateOfOrigin: dto.stateOfOrigin ?? null,
      lgaOfOrigin: dto.lgaOfOrigin ?? null,
      disabilityStatus: dto.disabilityStatus ?? false,
      disabilityType: dto.disabilityType ?? null,
      enrolmentType: dto.enrolmentType,
      distanceToSchoolKm: dto.distanceToSchoolKm ?? null,
      transportMode: dto.transportMode ?? null,
      guardianName: dto.guardianName ?? null,
      guardianPhone: dto.guardianPhone ?? null,
      enrolmentDate: toDate(dto.enrolmentDate),
      exitDate: toDate(dto.exitDate),
      exitReason: dto.exitReason ?? null,
    };
  }

  private async bumpStudents(
    schoolId: string,
    sessionId: string,
    userId: string,
  ) {
    const count = await this.prisma.studentRecord.count({
      where: { schoolId, sessionId },
    });
    await this.refreshSection(
      schoolId,
      sessionId,
      userId,
      'studentsStatus',
      count,
    );
  }

  // ─── Staff ───────────────────────────────────────────────────────────────────

  async listStaff(user: RequestUser, schoolId: string) {
    const session = await this.sessionScope(user, schoolId);
    const rows = session
      ? await this.prisma.staffRecord.findMany({
          where: { schoolId, sessionId: session.id },
          orderBy: [{ isHeadTeacher: 'desc' }, { lastName: 'asc' }],
        })
      : [];
    return {
      session,
      rows,
      status: await this.sectionStatus(schoolId, session, 'staffStatus'),
    };
  }

  async createStaff(user: RequestUser, schoolId: string, dto: StaffRecordDto) {
    const session = await this.prepare(user, schoolId);
    await this.assertSingleHeadTeacher(schoolId, session.id, dto.isHeadTeacher);
    try {
      const row = await this.prisma.staffRecord.create({
        data: { schoolId, sessionId: session.id, collectedById: user.id, ...this.staffData(dto) },
      });
      await this.bumpStaff(schoolId, session.id, user.id);
      return row;
    } catch (e: any) {
      if (e?.code === 'P2002')
        throw this.duplicate(
          `A staff member with code "${dto.staffCode}" already exists for this school.`,
        );
      throw e;
    }
  }

  async updateStaff(
    user: RequestUser,
    schoolId: string,
    rowId: string,
    dto: StaffRecordDto,
  ) {
    const session = await this.prepare(user, schoolId);
    await this.ownedRow('staffRecord', rowId, schoolId, session.id);
    await this.assertSingleHeadTeacher(
      schoolId,
      session.id,
      dto.isHeadTeacher,
      rowId,
    );
    try {
      const row = await this.prisma.staffRecord.update({
        where: { id: rowId },
        data: this.staffData(dto),
      });
      await this.bumpStaff(schoolId, session.id, user.id);
      return row;
    } catch (e: any) {
      if (e?.code === 'P2002')
        throw this.duplicate(
          `A staff member with code "${dto.staffCode}" already exists for this school.`,
        );
      throw e;
    }
  }

  async removeStaff(user: RequestUser, schoolId: string, rowId: string) {
    const session = await this.prepare(user, schoolId);
    await this.ownedRow('staffRecord', rowId, schoolId, session.id);
    await this.prisma.staffRecord.delete({ where: { id: rowId } });
    await this.bumpStaff(schoolId, session.id, user.id);
    return { message: 'Staff member removed.' };
  }

  async submitStaff(user: RequestUser, schoolId: string) {
    const session = await this.prepare(user, schoolId);
    const count = await this.prisma.staffRecord.count({
      where: { schoolId, sessionId: session.id },
    });
    if (count === 0) {
      throw new BadRequestException(
        'Add at least one staff member before submitting.',
      );
    }
    const visit = await this.schools.ensureVisit(schoolId, session.id, user.id);
    await this.schools.setSectionStatus(
      visit.id,
      'staffStatus',
      CaptureStatus.SUBMITTED,
    );
    return { message: 'Staff register submitted.' };
  }

  private staffData(dto: StaffRecordDto) {
    return {
      staffCode: dto.staffCode,
      firstName: dto.firstName,
      middleName: dto.middleName ?? null,
      lastName: dto.lastName,
      gender: dto.gender as Gender,
      dateOfBirth: toDate(dto.dateOfBirth),
      phoneNumber: dto.phoneNumber ?? null,
      staffType: dto.staffType,
      employmentType: dto.employmentType,
      qualification: dto.qualification,
      subject: dto.subject ?? null,
      dateOfFirstAppointment: toDate(dto.dateOfFirstAppointment),
      datePostedToSchool: toDate(dto.datePostedToSchool),
      isResidentInCommunity: dto.isResidentInCommunity,
      yearsAtCurrentSchool: dto.yearsAtCurrentSchool ?? null,
      isHeadTeacher: dto.isHeadTeacher,
    };
  }

  // Only one head teacher / principal per school per session (guide §4).
  private async assertSingleHeadTeacher(
    schoolId: string,
    sessionId: string,
    isHeadTeacher: boolean,
    excludeId?: string,
  ) {
    if (!isHeadTeacher) return;
    const existing = await this.prisma.staffRecord.findFirst({
      where: {
        schoolId,
        sessionId,
        isHeadTeacher: true,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
    });
    if (existing) {
      throw new ConflictException(
        `${existing.firstName} ${existing.lastName} is already marked as head teacher for this school.`,
      );
    }
  }

  private async bumpStaff(schoolId: string, sessionId: string, userId: string) {
    const count = await this.prisma.staffRecord.count({
      where: { schoolId, sessionId },
    });
    await this.refreshSection(schoolId, sessionId, userId, 'staffStatus', count);
  }

  // ─── Shared helpers ──────────────────────────────────────────────────────────

  // Confirm a row belongs to this school + current session before mutating it.
  private async ownedRow(
    model: 'ascRecord' | 'studentRecord' | 'staffRecord',
    rowId: string,
    schoolId: string,
    sessionId: string,
  ) {
    const row = await (this.prisma[model] as any).findUnique({
      where: { id: rowId },
    });
    if (!row || row.schoolId !== schoolId || row.sessionId !== sessionId) {
      throw new NotFoundException('Record not found.');
    }
    return row;
  }

  private async sectionStatus(
    schoolId: string,
    session: { id: string } | null,
    field: 'ascStatus' | 'studentsStatus' | 'staffStatus',
  ): Promise<CaptureStatus> {
    if (!session) return CaptureStatus.NOT_STARTED;
    const visit = await this.prisma.schoolVisit.findUnique({
      where: { schoolId_sessionId: { schoolId, sessionId: session.id } },
    });
    return (visit?.[field] as CaptureStatus) ?? CaptureStatus.NOT_STARTED;
  }
}
