import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from '../sessions/sessions.service';
import type { Prisma } from '../generated/prisma/client';
import { CaptureStatus, CaptureSource } from '../generated/prisma/client';
import { SecurityAssessmentDto } from './dto/security-assessment.dto';
import { computeRiskScores } from './risk-score';

// The per-section status columns on SchoolVisit.
export type SectionField =
  | 'ascStatus'
  | 'studentsStatus'
  | 'staffStatus'
  | 'securityStatus'
  | 'mediaStatus';

// Sections currently implemented for LIE capture. All five Module 1 sections are
// live, so overall rolls up across the full set.
const ACTIVE_SECTIONS: SectionField[] = [
  'ascStatus',
  'studentsStatus',
  'staffStatus',
  'securityStatus',
  'mediaStatus',
];

// Roll the active section statuses up into a single overall status.
function rollupOverall(statuses: CaptureStatus[]): CaptureStatus {
  if (statuses.every((s) => s === CaptureStatus.NOT_STARTED)) {
    return CaptureStatus.NOT_STARTED;
  }
  if (statuses.every((s) => s === CaptureStatus.VERIFIED)) {
    return CaptureStatus.VERIFIED;
  }
  if (
    statuses.every(
      (s) => s === CaptureStatus.SUBMITTED || s === CaptureStatus.VERIFIED,
    )
  ) {
    return CaptureStatus.SUBMITTED;
  }
  return CaptureStatus.DRAFT;
}

// Shape of request.user produced by JwtStrategy.validate().
export interface RequestUser {
  id: string;
  role: string;
  assignedLga: string | null;
  assignedZone: string | null;
  assignedCluster: string | null;
  assignedSchoolId: string | null;
}

// Which capture channel a caller writes to. Principals produce a SEPARATE
// PRINCIPAL-source record that coexists with the inspector's; everyone else
// writes the INSPECTOR record. Part of the unique key on every capture table.
export function sourceForUser(user: RequestUser): CaptureSource {
  return user.role === 'PRINCIPAL'
    ? CaptureSource.PRINCIPAL
    : CaptureSource.INSPECTOR;
}

export interface SchoolWorklistItem {
  id: string;
  code: string;
  name: string;
  type: string;
  ownership: string;
  category: string;
  genderCategory: string;
  lgaName: string;
  ward: string | null;
  community: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  // Capture progress for the current session.
  visitId: string | null;
  status: string; // CaptureStatus, NOT_STARTED when no visit exists yet
  sections: {
    asc: string;
    students: string;
    staff: string;
    security: string;
    media: string;
  } | null;
}

@Injectable()
export class SchoolsService {
  constructor(
    private prisma: PrismaService,
    private sessions: SessionsService,
  ) {}

  // Geographic scoping is enforced HERE, not in the guard (RBAC Rule 3).
  // ZONAL_COORD → their zone; INSPECT_OFFICER → their cluster; EMIS_OFFICER /
  // SYS_ADMIN / leadership → state-wide; PRINCIPAL → their single school.
  //
  // ⚠️ LIE is state-wide here by product decision (2026-07 — MoEST/Alexander want
  // an LIE to see every school). This DEVIATES from RBAC v1.1 ("LIE = LGA-scoped")
  // and must be signed off by Alexander before production.
  private scopeFor(user: RequestUser): Prisma.SchoolWhereInput | null {
    const where: Prisma.SchoolWhereInput = { isActive: true };
    switch (user.role) {
      case 'LIE':
        // State-wide (see note above; was `where.lgaName = user.assignedLga`).
        return where;
      case 'PRINCIPAL':
        // School head — scoped to exactly the one school they're bound to.
        if (!user.assignedSchoolId) return null;
        where.id = user.assignedSchoolId;
        return where;
      case 'ZONAL_COORD':
        if (user.assignedZone) where.zoneName = user.assignedZone;
        return where;
      case 'INSPECT_OFFICER':
        // Directorate field officer — scoped to their assigned cluster.
        if (!user.assignedCluster) return null;
        where.cluster = user.assignedCluster;
        return where;
      case 'EMIS_OFFICER':
      case 'HOD_APPROVE':
      case 'EXEC_VIEW':
      case 'SYS_ADMIN':
        // State-wide read (leadership / state officers).
        return where;
      default:
        return null;
    }
  }

  // Public accessor so the oversight layer applies the identical RBAC scope.
  scopeWhere(user: RequestUser): Prisma.SchoolWhereInput | null {
    return this.scopeFor(user);
  }

  async listForUser(user: RequestUser): Promise<{
    session: { id: string; name: string } | null;
    schools: SchoolWorklistItem[];
  }> {
    const where = this.scopeFor(user);
    const session = await this.sessions.findCurrent();
    const period = await this.sessions.findCurrentPeriod();
    const source = sourceForUser(user);

    if (!where) return { session, schools: [] };

    const schools = await this.prisma.school.findMany({
      where,
      orderBy: { name: 'asc' },
      // Filter to the current capture PERIOD AND the caller's own channel; when no
      // period is configured the sentinel id matches nothing, so every school comes
      // back with an empty visits array.
      include: {
        visits: {
          where: { periodId: period?.id ?? '__no_period__', source },
          take: 1,
        },
      },
    });

    const items: SchoolWorklistItem[] = schools.map((s) => {
      const visit = s.visits[0];
      return {
        id: s.id,
        code: s.code,
        name: s.name,
        type: s.type,
        ownership: s.ownership,
        category: s.category,
        genderCategory: s.genderCategory,
        lgaName: s.lgaName,
        ward: s.ward,
        community: s.community,
        address: s.address,
        latitude: s.latitude,
        longitude: s.longitude,
        visitId: visit?.id ?? null,
        status: visit?.overallStatus ?? 'NOT_STARTED',
        sections: visit
          ? {
              asc: visit.ascStatus,
              students: visit.studentsStatus,
              staff: visit.staffStatus,
              security: visit.securityStatus,
              media: visit.mediaStatus,
            }
          : null,
      };
    });

    return {
      session: session ? { id: session.id, name: session.name } : null,
      schools: items,
    };
  }

  // Minimal, unauthenticated school directory for the self-registration school
  // picker (a prospective principal has no account yet). PII-free: id/name/code/LGA
  // of active schools only.
  async listPublic() {
    const schools = await this.prisma.school.findMany({
      where: { isActive: true },
      orderBy: [{ lgaName: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, code: true, lgaName: true },
    });
    return { schools };
  }

  // ─── Single school + assessment ─────────────────────────────────────────────

  // Fetch a school only if it falls within the caller's scope; otherwise 404
  // (don't reveal that an out-of-scope school exists). Public so the register
  // services can reuse the same scoping rule.
  async requireScopedSchool(user: RequestUser, id: string) {
    const scope = this.scopeFor(user);
    if (!scope) throw new NotFoundException('School not found.');
    // AND the requested id with the scope — never spread it in, or a scope that
    // constrains on `id` itself (PRINCIPAL) would be clobbered by the param.
    const school = await this.prisma.school.findFirst({
      where: { AND: [scope, { id }] },
    });
    if (!school) throw new NotFoundException('School not found.');
    return school;
  }

  // Fields whose absence blocks submission (the rest stay optional per the
  // guide). Conditionals are checked separately.
  private static readonly REQUIRED_FOR_SUBMIT: Array<
    keyof SecurityAssessmentDto
  > = [
    'roadSurfaceType',
    'forestProximity',
    'perimeterFenceStatus',
    'numberOfEntryPoints',
    'hasFunctionalGate',
    'hasCctv',
    'hasElectricity',
    'hasExternalLighting',
    'hasPhoneNetwork',
    'signalStrength',
    'hasEmergencyProtocol',
    'hadSecurityIncident',
  ];

  // Resolve which capture period a read targets: an explicit historical period, or
  // the current one. Returns the period plus whether it is the current (writable)
  // one — a non-current period is read-only history.
  async resolveViewPeriod(periodId?: string) {
    const current = await this.sessions.findCurrentPeriod();
    const period = periodId
      ? await this.prisma.capturePeriod.findUnique({ where: { id: periodId } })
      : current;
    const readOnly = !period || !current || period.id !== current.id;
    return { period, current, readOnly };
  }

  async getDetail(user: RequestUser, id: string, periodId?: string) {
    const school = await this.requireScopedSchool(user, id);
    const source = sourceForUser(user);
    const { period, readOnly } = await this.resolveViewPeriod(periodId);
    // Session name for display comes from the period's session.
    const sess = period
      ? await this.prisma.session.findUnique({
          where: { id: period.sessionId },
          select: { id: true, name: true },
        })
      : null;

    const visit = period
      ? await this.prisma.schoolVisit.findUnique({
          where: {
            schoolId_periodId_source: { schoolId: id, periodId: period.id, source },
          },
        })
      : null;

    const security = period
      ? await this.prisma.schoolSecurityProfile.findUnique({
          where: {
            schoolId_periodId_source: { schoolId: id, periodId: period.id, source },
          },
        })
      : null;

    return {
      school,
      session: sess,
      period: period
        ? {
            id: period.id,
            name: period.name,
            isCurrent: period.isCurrent,
            closedAt: period.closedAt,
          }
        : null,
      readOnly,
      visit: visit
        ? {
            id: visit.id,
            sections: {
              asc: visit.ascStatus,
              students: visit.studentsStatus,
              staff: visit.staffStatus,
              security: visit.securityStatus,
              media: visit.mediaStatus,
            },
            overallStatus: visit.overallStatus,
          }
        : null,
      security,
    };
  }

  // Create the visit row on first capture (NOT_STARTED until a section starts),
  // claiming it for this inspector if unclaimed. Public for the register services.
  // `periodId` + `source` keep each capture round / channel a separate record.
  async ensureVisit(
    schoolId: string,
    periodId: string,
    sessionId: string,
    inspectorId: string,
    source: CaptureSource = CaptureSource.INSPECTOR,
  ) {
    return this.prisma.schoolVisit.upsert({
      where: { schoolId_periodId_source: { schoolId, periodId, source } },
      create: { schoolId, periodId, sessionId, inspectorId, source },
      update: {},
    });
  }

  async saveSecurity(
    user: RequestUser,
    id: string,
    dto: SecurityAssessmentDto,
  ) {
    await this.requireScopedSchool(user, id);
    const period = await this.sessions.getCurrentPeriodOrThrow();
    const source = sourceForUser(user);
    const visit = await this.ensureVisit(
      id,
      period.id,
      period.sessionId,
      user.id,
      source,
    );

    // Don't downgrade an already-submitted/verified section to DRAFT on edit.
    const existing = await this.prisma.schoolSecurityProfile.findUnique({
      where: {
        schoolId_periodId_source: { schoolId: id, periodId: period.id, source },
      },
    });
    const status = existing?.recordStatus ?? CaptureStatus.DRAFT;

    await this.prisma.schoolSecurityProfile.upsert({
      where: {
        schoolId_periodId_source: { schoolId: id, periodId: period.id, source },
      },
      create: {
        schoolId: id,
        sessionId: period.sessionId,
        periodId: period.id,
        source,
        collectedById: user.id,
        recordStatus: CaptureStatus.DRAFT,
        ...dto,
      },
      update: { collectedById: user.id, ...dto },
    });

    await this.setSectionStatus(visit.id, 'securityStatus', status);
    return this.getDetail(user, id);
  }

  async submitSecurity(
    user: RequestUser,
    id: string,
    dto: SecurityAssessmentDto,
  ) {
    await this.requireScopedSchool(user, id);
    const period = await this.sessions.getCurrentPeriodOrThrow();
    const source = sourceForUser(user);
    const visit = await this.ensureVisit(
      id,
      period.id,
      period.sessionId,
      user.id,
      source,
    );

    const existing = await this.prisma.schoolSecurityProfile.findUnique({
      where: {
        schoolId_periodId_source: { schoolId: id, periodId: period.id, source },
      },
    });

    // The complete picture = whatever was saved before, overlaid with this payload.
    const effective: Record<string, unknown> = { ...(existing ?? {}), ...dto };
    this.assertSubmittable(effective);

    const scores = computeRiskScores(effective as SecurityAssessmentDto);

    await this.prisma.schoolSecurityProfile.upsert({
      where: {
        schoolId_periodId_source: { schoolId: id, periodId: period.id, source },
      },
      create: {
        schoolId: id,
        sessionId: period.sessionId,
        periodId: period.id,
        source,
        collectedById: user.id,
        ...dto,
        ...scores,
        recordStatus: CaptureStatus.SUBMITTED,
        submittedAt: new Date(),
      },
      update: {
        collectedById: user.id,
        ...dto,
        ...scores,
        recordStatus: CaptureStatus.SUBMITTED,
        submittedAt: new Date(),
      },
    });

    await this.setSectionStatus(visit.id, 'securityStatus', CaptureStatus.SUBMITTED);
    return this.getDetail(user, id);
  }

  private assertSubmittable(values: Record<string, unknown>) {
    const missing = SchoolsService.REQUIRED_FOR_SUBMIT.filter((k) => {
      const v = values[k];
      return v === undefined || v === null || v === '';
    });

    // Incident detail is required only when an incident is reported.
    if (values.hadSecurityIncident === true) {
      for (const k of [
        'incidentCount',
        'mostRecentIncidentYear',
        'mostRecentIncidentType',
      ]) {
        const v = values[k];
        if (v === undefined || v === null || v === '') missing.push(k as never);
      }
    }

    if (missing.length > 0) {
      throw new BadRequestException(
        `Complete these fields before submitting: ${missing.join(', ')}`,
      );
    }
  }

  // Set one section's status and recompute the overall roll-up across the active
  // sections. Public so the register services can call it after their mutations.
  async setSectionStatus(
    visitId: string,
    field: SectionField,
    status: CaptureStatus,
  ) {
    const visit = await this.prisma.schoolVisit.findUnique({
      where: { id: visitId },
    });
    if (!visit) return;

    const next = { ...visit, [field]: status } as Record<
      SectionField,
      CaptureStatus
    >;
    const overallStatus = rollupOverall(
      ACTIVE_SECTIONS.map((f) => next[f]),
    );

    await this.prisma.schoolVisit.update({
      where: { id: visitId },
      data: { [field]: status, overallStatus },
    });
  }
}
