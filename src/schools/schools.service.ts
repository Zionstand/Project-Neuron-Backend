import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from '../sessions/sessions.service';
import type { Prisma } from '../generated/prisma/client';
import { CaptureStatus } from '../generated/prisma/client';
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
  // LIE → their assigned LGA; ZONAL_COORD → their zone; EMIS_OFFICER / SYS_ADMIN
  // → state-wide. A LIE with no assigned LGA sees nothing.
  private scopeFor(user: RequestUser): Prisma.SchoolWhereInput | null {
    const where: Prisma.SchoolWhereInput = { isActive: true };
    switch (user.role) {
      case 'LIE':
        if (!user.assignedLga) return null;
        where.lgaName = user.assignedLga;
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

    if (!where) return { session, schools: [] };

    const schools = await this.prisma.school.findMany({
      where,
      orderBy: { name: 'asc' },
      // Filter to the current session; when none is configured the sentinel id
      // matches nothing, so every school comes back with an empty visits array.
      include: {
        visits: { where: { sessionId: session?.id ?? '__no_session__' }, take: 1 },
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

  // ─── Single school + assessment ─────────────────────────────────────────────

  // Fetch a school only if it falls within the caller's scope; otherwise 404
  // (don't reveal that an out-of-scope school exists). Public so the register
  // services can reuse the same scoping rule.
  async requireScopedSchool(user: RequestUser, id: string) {
    const scope = this.scopeFor(user);
    if (!scope) throw new NotFoundException('School not found.');
    const school = await this.prisma.school.findFirst({
      where: { ...scope, id },
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

  async getDetail(user: RequestUser, id: string) {
    const school = await this.requireScopedSchool(user, id);
    const session = await this.sessions.findCurrent();

    const visit = session
      ? await this.prisma.schoolVisit.findUnique({
          where: { schoolId_sessionId: { schoolId: id, sessionId: session.id } },
        })
      : null;

    const security = session
      ? await this.prisma.schoolSecurityProfile.findUnique({
          where: { schoolId_sessionId: { schoolId: id, sessionId: session.id } },
        })
      : null;

    return {
      school,
      session: session ? { id: session.id, name: session.name } : null,
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
  async ensureVisit(
    schoolId: string,
    sessionId: string,
    inspectorId: string,
  ) {
    return this.prisma.schoolVisit.upsert({
      where: { schoolId_sessionId: { schoolId, sessionId } },
      create: { schoolId, sessionId, inspectorId },
      update: {},
    });
  }

  async saveSecurity(
    user: RequestUser,
    id: string,
    dto: SecurityAssessmentDto,
  ) {
    await this.requireScopedSchool(user, id);
    const session = await this.sessions.getCurrentOrThrow();
    const visit = await this.ensureVisit(id, session.id, user.id);

    // Don't downgrade an already-submitted/verified section to DRAFT on edit.
    const existing = await this.prisma.schoolSecurityProfile.findUnique({
      where: { schoolId_sessionId: { schoolId: id, sessionId: session.id } },
    });
    const status = existing?.recordStatus ?? CaptureStatus.DRAFT;

    await this.prisma.schoolSecurityProfile.upsert({
      where: { schoolId_sessionId: { schoolId: id, sessionId: session.id } },
      create: {
        schoolId: id,
        sessionId: session.id,
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
    const session = await this.sessions.getCurrentOrThrow();
    const visit = await this.ensureVisit(id, session.id, user.id);

    const existing = await this.prisma.schoolSecurityProfile.findUnique({
      where: { schoolId_sessionId: { schoolId: id, sessionId: session.id } },
    });

    // The complete picture = whatever was saved before, overlaid with this payload.
    const effective: Record<string, unknown> = { ...(existing ?? {}), ...dto };
    this.assertSubmittable(effective);

    const scores = computeRiskScores(effective as SecurityAssessmentDto);

    await this.prisma.schoolSecurityProfile.upsert({
      where: { schoolId_sessionId: { schoolId: id, sessionId: session.id } },
      create: {
        schoolId: id,
        sessionId: session.id,
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
