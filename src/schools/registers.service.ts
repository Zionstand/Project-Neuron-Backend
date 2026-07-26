import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from '../sessions/sessions.service';
import {
  SchoolsService,
  sourceForUser,
  type RequestUser,
} from './schools.service';
import {
  CaptureStatus,
  CaptureSource,
  Gender,
} from '../generated/prisma/client';
import {
  AscRecordDto,
  StudentRecordDto,
  StaffRecordDto,
} from './dto/register.dto';

const toDate = (v?: string | null) => (v ? new Date(v) : null);

// The current capture period, carrying the session it belongs to.
type Period = { id: string; sessionId: string };

@Injectable()
export class RegistersService {
  constructor(
    private prisma: PrismaService,
    private sessions: SessionsService,
    private schools: SchoolsService,
  ) {}

  // Common preamble for writes: confirm scope, resolve the current capture period,
  // ensure the visit row exists. Returns the period (which carries its sessionId).
  private async prepare(user: RequestUser, schoolId: string): Promise<Period> {
    await this.schools.requireScopedSchool(user, schoolId);
    const period = await this.sessions.getCurrentPeriodOrThrow();
    await this.schools.ensureVisit(
      schoolId,
      period.id,
      period.sessionId,
      user.id,
      sourceForUser(user),
    );
    return period;
  }

  // For reads: the current period (nullable when none is configured).
  private async periodScope(
    user: RequestUser,
    schoolId: string,
  ): Promise<Period | null> {
    await this.schools.requireScopedSchool(user, schoolId);
    return this.sessions.findCurrentPeriod();
  }

  // Recompute a register's section status from its row count (NOT_STARTED when
  // empty, DRAFT otherwise) and roll it into the visit for this capture channel.
  private async refreshSection(
    schoolId: string,
    periodId: string,
    sessionId: string,
    inspectorId: string,
    source: CaptureSource,
    field: 'ascStatus' | 'studentsStatus' | 'staffStatus',
    count: number,
  ) {
    const visit = await this.schools.ensureVisit(
      schoolId,
      periodId,
      sessionId,
      inspectorId,
      source,
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

  // Resolve a captured STRING to its normalized dimension FK id (best-effort; null
  // if the value isn't in the reference table). Set alongside the string on save.
  private async classLevelId(code: string): Promise<string | null> {
    const row = await this.prisma.classLevel.findUnique({ where: { code } });
    return row?.id ?? null;
  }
  private async qualId(code: string): Promise<string | null> {
    const row = await this.prisma.qualificationType.findUnique({ where: { code } });
    return row?.id ?? null;
  }
  private async subjectId(name?: string | null): Promise<string | null> {
    if (!name) return null;
    const row = await this.prisma.subjectArea.findUnique({ where: { name } });
    return row?.id ?? null;
  }

  // ─── ASC ───────────────────────────────────────────────────────────────────

  async listAsc(user: RequestUser, schoolId: string) {
    const period = await this.periodScope(user, schoolId);
    const source = sourceForUser(user);
    const rows = period
      ? await this.prisma.ascRecord.findMany({
          where: { schoolId, periodId: period.id, source },
          orderBy: [{ classLevel: 'asc' }, { gender: 'asc' }],
        })
      : [];
    return {
      session: period ? { id: period.sessionId } : null,
      rows,
      status: await this.sectionStatus(schoolId, period, source, 'ascStatus'),
    };
  }

  // One or more census rows. The section status is recomputed once at the end
  // rather than per row — see `createMany` for the batch semantics.
  async createAsc(user: RequestUser, schoolId: string, dtos: AscRecordDto[]) {
    for (const dto of dtos) {
      if (dto.newEntrants > dto.enrolmentCount) {
        throw new BadRequestException(
          'New entrants cannot exceed the enrolment count.',
        );
      }
    }
    const period = await this.prepare(user, schoolId);
    const source = sourceForUser(user);
    try {
      return await this.createMany(dtos, (dto) =>
        this.writeRow(
          'ascRecord',
          { schoolId, periodId: period.id, source, clientId: dto.clientId },
          async () => ({
            schoolId,
            sessionId: period.sessionId,
            periodId: period.id,
            source,
            collectedById: user.id,
            clientId: dto.clientId ?? null,
            classLevel: dto.classLevel,
            classLevelId: await this.classLevelId(dto.classLevel),
            gender: dto.gender as Gender,
            enrolmentCount: dto.enrolmentCount,
            newEntrants: dto.newEntrants,
            repeaters: dto.repeaters,
            dropoutCount: dto.dropoutCount,
          }),
          `${dto.classLevel} ${dto.gender} has already been recorded for this school.`,
        ),
      );
    } finally {
      // Runs even when a mid-batch row fails, so the section status reflects the
      // rows that did land.
      await this.bumpAsc(schoolId, period, user.id, source);
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
    const period = await this.prepare(user, schoolId);
    const source = sourceForUser(user);
    await this.ownedRow('ascRecord', rowId, schoolId, period.id, source);
    try {
      const row = await this.prisma.ascRecord.update({
        where: { id: rowId },
        data: {
          classLevel: dto.classLevel,
          classLevelId: await this.classLevelId(dto.classLevel),
          gender: dto.gender as Gender,
          enrolmentCount: dto.enrolmentCount,
          newEntrants: dto.newEntrants,
          repeaters: dto.repeaters,
          dropoutCount: dto.dropoutCount,
        },
      });
      await this.bumpAsc(schoolId, period, user.id, source);
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
    const period = await this.prepare(user, schoolId);
    const source = sourceForUser(user);
    await this.ownedRow('ascRecord', rowId, schoolId, period.id, source);
    await this.prisma.ascRecord.delete({ where: { id: rowId } });
    await this.bumpAsc(schoolId, period, user.id, source);
    return { message: 'Record removed.' };
  }

  async submitAsc(user: RequestUser, schoolId: string) {
    const period = await this.prepare(user, schoolId);
    const source = sourceForUser(user);
    const count = await this.prisma.ascRecord.count({
      where: { schoolId, periodId: period.id, source },
    });
    if (count === 0) {
      throw new BadRequestException(
        'Add at least one class enrolment row before submitting.',
      );
    }
    const visit = await this.schools.ensureVisit(
      schoolId,
      period.id,
      period.sessionId,
      user.id,
      source,
    );
    await this.schools.setSectionStatus(
      visit.id,
      'ascStatus',
      CaptureStatus.SUBMITTED,
    );
    return { message: 'Annual School Census submitted.' };
  }

  private async bumpAsc(
    schoolId: string,
    period: Period,
    userId: string,
    source: CaptureSource,
  ) {
    const count = await this.prisma.ascRecord.count({
      where: { schoolId, periodId: period.id, source },
    });
    await this.refreshSection(
      schoolId,
      period.id,
      period.sessionId,
      userId,
      source,
      'ascStatus',
      count,
    );
  }

  // ─── Students ────────────────────────────────────────────────────────────────

  async listStudents(user: RequestUser, schoolId: string) {
    const period = await this.periodScope(user, schoolId);
    const source = sourceForUser(user);
    const rows = period
      ? await this.prisma.studentRecord.findMany({
          where: { schoolId, periodId: period.id, source },
          orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
        })
      : [];
    return {
      session: period ? { id: period.sessionId } : null,
      rows,
      status: await this.sectionStatus(
        schoolId,
        period,
        source,
        'studentsStatus',
      ),
    };
  }

  async createStudent(
    user: RequestUser,
    schoolId: string,
    dtos: StudentRecordDto[],
  ) {
    const period = await this.prepare(user, schoolId);
    const source = sourceForUser(user);
    try {
      return await this.createMany(dtos, (dto) =>
        this.writeRow(
          'studentRecord',
          { schoolId, periodId: period.id, source, clientId: dto.clientId },
          async () => ({
            schoolId,
            sessionId: period.sessionId,
            periodId: period.id,
            source,
            collectedById: user.id,
            clientId: dto.clientId ?? null,
            classLevelId: await this.classLevelId(dto.classLevel),
            ...this.studentData(dto),
          }),
          `A student with code "${dto.studentCode}" already exists for this school.`,
        ),
      );
    } finally {
      await this.bumpStudents(schoolId, period, user.id, source);
    }
  }

  async updateStudent(
    user: RequestUser,
    schoolId: string,
    rowId: string,
    dto: StudentRecordDto,
  ) {
    const period = await this.prepare(user, schoolId);
    const source = sourceForUser(user);
    await this.ownedRow('studentRecord', rowId, schoolId, period.id, source);
    try {
      const row = await this.prisma.studentRecord.update({
        where: { id: rowId },
        data: {
          classLevelId: await this.classLevelId(dto.classLevel),
          ...this.studentData(dto),
        },
      });
      await this.bumpStudents(schoolId, period, user.id, source);
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
    const period = await this.prepare(user, schoolId);
    const source = sourceForUser(user);
    await this.ownedRow('studentRecord', rowId, schoolId, period.id, source);
    await this.prisma.studentRecord.delete({ where: { id: rowId } });
    await this.bumpStudents(schoolId, period, user.id, source);
    return { message: 'Student removed.' };
  }

  async submitStudents(user: RequestUser, schoolId: string) {
    const period = await this.prepare(user, schoolId);
    const source = sourceForUser(user);
    const count = await this.prisma.studentRecord.count({
      where: { schoolId, periodId: period.id, source },
    });
    if (count === 0) {
      throw new BadRequestException(
        'Add at least one student before submitting.',
      );
    }
    const visit = await this.schools.ensureVisit(
      schoolId,
      period.id,
      period.sessionId,
      user.id,
      source,
    );
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
    period: Period,
    userId: string,
    source: CaptureSource,
  ) {
    const count = await this.prisma.studentRecord.count({
      where: { schoolId, periodId: period.id, source },
    });
    await this.refreshSection(
      schoolId,
      period.id,
      period.sessionId,
      userId,
      source,
      'studentsStatus',
      count,
    );
  }

  // ─── Staff ───────────────────────────────────────────────────────────────────

  async listStaff(user: RequestUser, schoolId: string) {
    const period = await this.periodScope(user, schoolId);
    const source = sourceForUser(user);
    const rows = period
      ? await this.prisma.staffRecord.findMany({
          where: { schoolId, periodId: period.id, source },
          orderBy: [{ isHeadTeacher: 'desc' }, { lastName: 'asc' }],
        })
      : [];
    return {
      session: period ? { id: period.sessionId } : null,
      rows,
      status: await this.sectionStatus(schoolId, period, source, 'staffStatus'),
    };
  }

  async createStaff(user: RequestUser, schoolId: string, dtos: StaffRecordDto[]) {
    const period = await this.prepare(user, schoolId);
    const source = sourceForUser(user);
    try {
      return await this.createMany(dtos, async (dto) => {
        // On a replay the row being written may itself be the head teacher on
        // record, so exclude it — otherwise resending a batch conflicts with the
        // row it is meant to update.
        const existingId = await this.rowIdForClientId(
          'staffRecord',
          schoolId,
          period.id,
          source,
          dto.clientId,
        );
        await this.assertSingleHeadTeacher(
          schoolId,
          period.id,
          source,
          dto.isHeadTeacher,
          existingId,
        );
        return this.writeRow(
          'staffRecord',
          { schoolId, periodId: period.id, source, clientId: dto.clientId },
          async () => ({
            schoolId,
            sessionId: period.sessionId,
            periodId: period.id,
            source,
            collectedById: user.id,
            clientId: dto.clientId ?? null,
            qualId: await this.qualId(dto.qualification),
            subjectId: await this.subjectId(dto.subject),
            ...this.staffData(dto),
          }),
          `A staff member with code "${dto.staffCode}" already exists for this school.`,
        );
      });
    } finally {
      await this.bumpStaff(schoolId, period, user.id, source);
    }
  }

  async updateStaff(
    user: RequestUser,
    schoolId: string,
    rowId: string,
    dto: StaffRecordDto,
  ) {
    const period = await this.prepare(user, schoolId);
    const source = sourceForUser(user);
    await this.ownedRow('staffRecord', rowId, schoolId, period.id, source);
    await this.assertSingleHeadTeacher(
      schoolId,
      period.id,
      source,
      dto.isHeadTeacher,
      rowId,
    );
    try {
      const row = await this.prisma.staffRecord.update({
        where: { id: rowId },
        data: {
          qualId: await this.qualId(dto.qualification),
          subjectId: await this.subjectId(dto.subject),
          ...this.staffData(dto),
        },
      });
      await this.bumpStaff(schoolId, period, user.id, source);
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
    const period = await this.prepare(user, schoolId);
    const source = sourceForUser(user);
    await this.ownedRow('staffRecord', rowId, schoolId, period.id, source);
    await this.prisma.staffRecord.delete({ where: { id: rowId } });
    await this.bumpStaff(schoolId, period, user.id, source);
    return { message: 'Staff member removed.' };
  }

  async submitStaff(user: RequestUser, schoolId: string) {
    const period = await this.prepare(user, schoolId);
    const source = sourceForUser(user);
    const count = await this.prisma.staffRecord.count({
      where: { schoolId, periodId: period.id, source },
    });
    if (count === 0) {
      throw new BadRequestException(
        'Add at least one staff member before submitting.',
      );
    }
    const visit = await this.schools.ensureVisit(
      schoolId,
      period.id,
      period.sessionId,
      user.id,
      source,
    );
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

  // Only one head teacher / principal per school per PERIOD (guide §4), scoped to
  // the capture channel so an inspector and a principal register independently.
  private async assertSingleHeadTeacher(
    schoolId: string,
    periodId: string,
    source: CaptureSource,
    isHeadTeacher: boolean,
    excludeId?: string,
  ) {
    if (!isHeadTeacher) return;
    const existing = await this.prisma.staffRecord.findFirst({
      where: {
        schoolId,
        periodId,
        source,
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

  private async bumpStaff(
    schoolId: string,
    period: Period,
    userId: string,
    source: CaptureSource,
  ) {
    const count = await this.prisma.staffRecord.count({
      where: { schoolId, periodId: period.id, source },
    });
    await this.refreshSection(
      schoolId,
      period.id,
      period.sessionId,
      userId,
      source,
      'staffStatus',
      count,
    );
  }

  // ─── Shared helpers ──────────────────────────────────────────────────────────

  // Apply a batch of captured rows in order.
  //
  // Deliberately NOT one transaction: a single bad row shouldn't discard the good
  // rows before it, because the device that sent them may not get another window
  // of connectivity soon. The contract that makes this safe is `clientId` — the
  // client can resend the entire batch and rows that already landed are updated
  // in place rather than duplicated, so a partial success plus a retry converges
  // on the same result as one clean run.
  private async createMany<D, R>(
    dtos: D[],
    write: (dto: D) => Promise<R>,
  ): Promise<R[]> {
    const rows: R[] = [];
    for (const dto of dtos) rows.push(await write(dto));
    return rows;
  }

  // Create the row — or update it in place when the device supplied a `clientId`
  // it has sent before. Without a clientId there is nothing to match on, so this
  // is a plain create (the behaviour every online caller had before batching).
  private async writeRow<R>(
    model: 'ascRecord' | 'studentRecord' | 'staffRecord',
    key: {
      schoolId: string;
      periodId: string;
      source: CaptureSource;
      clientId?: string;
    },
    buildData: () => Promise<Record<string, unknown>>,
    duplicateMessage: string,
  ): Promise<R> {
    const data = await buildData();
    const delegate = this.prisma[model] as any;
    try {
      if (!key.clientId) return await delegate.create({ data });
      const { schoolId, periodId, source, clientId } = key;
      return await delegate.upsert({
        where: {
          schoolId_periodId_source_clientId: {
            schoolId,
            periodId,
            source,
            clientId,
          },
        },
        create: data,
        update: data,
      });
    } catch (e: any) {
      // A clientId collision can't land here (that path upserts); a P2002 means
      // the row's natural key — class+gender, student code, staff code — is
      // already taken by a different record.
      if (e?.code === 'P2002') throw this.duplicate(duplicateMessage);
      throw e;
    }
  }

  // The id of the row a clientId already maps to, if any.
  private async rowIdForClientId(
    model: 'ascRecord' | 'studentRecord' | 'staffRecord',
    schoolId: string,
    periodId: string,
    source: CaptureSource,
    clientId?: string,
  ): Promise<string | undefined> {
    if (!clientId) return undefined;
    const row = await (this.prisma[model] as any).findUnique({
      where: {
        schoolId_periodId_source_clientId: {
          schoolId,
          periodId,
          source,
          clientId,
        },
      },
      select: { id: true },
    });
    return row?.id;
  }

  // Confirm a row belongs to this school + current PERIOD + capture channel before
  // mutating it (so a principal can't edit an inspector's row, or a closed period's).
  private async ownedRow(
    model: 'ascRecord' | 'studentRecord' | 'staffRecord',
    rowId: string,
    schoolId: string,
    periodId: string,
    source: CaptureSource,
  ) {
    const row = await (this.prisma[model] as any).findUnique({
      where: { id: rowId },
    });
    if (
      !row ||
      row.schoolId !== schoolId ||
      row.periodId !== periodId ||
      row.source !== source
    ) {
      throw new NotFoundException('Record not found.');
    }
    return row;
  }

  private async sectionStatus(
    schoolId: string,
    period: Period | null,
    source: CaptureSource,
    field: 'ascStatus' | 'studentsStatus' | 'staffStatus',
  ): Promise<CaptureStatus> {
    if (!period) return CaptureStatus.NOT_STARTED;
    const visit = await this.prisma.schoolVisit.findUnique({
      where: {
        schoolId_periodId_source: { schoolId, periodId: period.id, source },
      },
    });
    return (visit?.[field] as CaptureStatus) ?? CaptureStatus.NOT_STARTED;
  }
}
