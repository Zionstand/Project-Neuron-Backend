import {
  Injectable,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from '../sessions/sessions.service';
import {
  SchoolsService,
  type RequestUser,
  type SectionField,
} from '../schools/schools.service';
import { CaptureStatus } from '../generated/prisma/client';
import { AuditService } from '../audit/audit.service';

type SectionKey = 'asc' | 'students' | 'staff' | 'security' | 'media';

const FIELD: Record<SectionKey, SectionField> = {
  asc: 'ascStatus',
  students: 'studentsStatus',
  staff: 'staffStatus',
  security: 'securityStatus',
  media: 'mediaStatus',
};

const SECTION_LABEL: Record<SectionKey, string> = {
  asc: 'Annual School Census',
  students: 'Student Register',
  staff: 'Staff Register',
  security: 'Security & Vulnerability',
  media: 'Media Capture',
};

@Injectable()
export class OversightService {
  constructor(
    private prisma: PrismaService,
    private sessions: SessionsService,
    private schools: SchoolsService,
    private audit: AuditService,
  ) {}

  // ─── Submissions queue ──────────────────────────────────────────────────────
  async listSubmissions(user: RequestUser) {
    const session = await this.sessions.findCurrent();
    const scope = this.schools.scopeWhere(user);
    const empty = {
      session: session ? { id: session.id, name: session.name } : null,
      summary: { schoolsAwaiting: 0, sectionsAwaiting: 0 },
      items: [] as unknown[],
    };
    if (!session || !scope) return empty;

    const schools = await this.prisma.school.findMany({
      where: scope,
      orderBy: { name: 'asc' },
      include: { visits: { where: { sessionId: session.id }, take: 1 } },
    });

    let sectionsAwaiting = 0;
    const items = schools
      .map((s) => {
        const v = s.visits[0];
        if (!v) return null;
        const sections = {
          asc: v.ascStatus,
          students: v.studentsStatus,
          staff: v.staffStatus,
          security: v.securityStatus,
          media: v.mediaStatus,
        };
        const submitted = (Object.keys(FIELD) as SectionKey[]).filter(
          (k) => sections[k] === CaptureStatus.SUBMITTED,
        );
        const verified = (Object.keys(FIELD) as SectionKey[]).filter(
          (k) => sections[k] === CaptureStatus.VERIFIED,
        );
        if (submitted.length === 0) return null;
        sectionsAwaiting += submitted.length;
        return {
          schoolId: s.id,
          name: s.name,
          code: s.code,
          lgaName: s.lgaName,
          overallStatus: v.overallStatus,
          sections,
          submittedCount: submitted.length,
          verifiedCount: verified.length,
        };
      })
      .filter(Boolean);

    return {
      session: { id: session.id, name: session.name },
      summary: { schoolsAwaiting: items.length, sectionsAwaiting },
      items,
    };
  }

  // ─── Risk overview ──────────────────────────────────────────────────────────
  async riskOverview(user: RequestUser) {
    const session = await this.sessions.findCurrent();
    const scope = this.schools.scopeWhere(user);
    const tiers = { High: 0, Moderate: 0, Low: 0 };
    if (!session || !scope) {
      return {
        session: session ? { id: session.id, name: session.name } : null,
        tiers,
        items: [] as unknown[],
      };
    }

    const profiles = await this.prisma.schoolSecurityProfile.findMany({
      where: {
        sessionId: session.id,
        recordStatus: { in: [CaptureStatus.SUBMITTED, CaptureStatus.VERIFIED] },
        school: scope,
      },
      include: { school: { select: { name: true, code: true, lgaName: true } } },
      orderBy: { compositeRiskScore: 'desc' },
    });

    const items = profiles.map((p) => {
      if (p.riskTier && p.riskTier in tiers) {
        tiers[p.riskTier as keyof typeof tiers]++;
      }
      return {
        schoolId: p.schoolId,
        name: p.school.name,
        code: p.school.code,
        lgaName: p.school.lgaName,
        riskTier: p.riskTier,
        compositeRiskScore: p.compositeRiskScore,
        isolationScore: p.isolationScore,
        infrastructureScore: p.infrastructureScore,
        communicationScore: p.communicationScore,
        recordStatus: p.recordStatus,
      };
    });

    return { session: { id: session.id, name: session.name }, tiers, items };
  }

  // ─── Verify / return a section ──────────────────────────────────────────────
  async verify(user: RequestUser, schoolId: string, section: SectionKey) {
    const { visit, field } = await this.locateSection(user, schoolId, section);
    if (visit.status !== CaptureStatus.SUBMITTED) {
      throw new BadRequestException(
        `${SECTION_LABEL[section]} must be submitted before it can be verified.`,
      );
    }
    await this.schools.setSectionStatus(visit.id, field, CaptureStatus.VERIFIED);
    if (section === 'security') {
      await this.prisma.schoolSecurityProfile.updateMany({
        where: { schoolId, sessionId: visit.sessionId },
        data: { recordStatus: CaptureStatus.VERIFIED },
      });
    }
    await this.audit.log({
      actorId: user.id,
      action: 'SECTION_VERIFIED',
      targetType: 'SECTION',
      targetId: schoolId,
      targetLabel: SECTION_LABEL[section],
      metadata: { section },
    });
    return { message: `${SECTION_LABEL[section]} verified.` };
  }

  async returnForRevision(
    user: RequestUser,
    schoolId: string,
    section: SectionKey,
  ) {
    const { visit, field } = await this.locateSection(user, schoolId, section);
    if (
      visit.status !== CaptureStatus.SUBMITTED &&
      visit.status !== CaptureStatus.VERIFIED
    ) {
      throw new BadRequestException(
        'Only a submitted or verified section can be returned for revision.',
      );
    }
    await this.schools.setSectionStatus(visit.id, field, CaptureStatus.DRAFT);
    if (section === 'security') {
      await this.prisma.schoolSecurityProfile.updateMany({
        where: { schoolId, sessionId: visit.sessionId },
        data: { recordStatus: CaptureStatus.DRAFT },
      });
    }
    await this.audit.log({
      actorId: user.id,
      action: 'SECTION_RETURNED',
      targetType: 'SECTION',
      targetId: schoolId,
      targetLabel: SECTION_LABEL[section],
      metadata: { section },
    });
    return { message: `${SECTION_LABEL[section]} returned for revision.` };
  }

  private async locateSection(
    user: RequestUser,
    schoolId: string,
    section: SectionKey,
  ) {
    await this.schools.requireScopedSchool(user, schoolId);
    const session = await this.sessions.getCurrentOrThrow();
    const field = FIELD[section];
    const visit = await this.prisma.schoolVisit.findUnique({
      where: { schoolId_sessionId: { schoolId, sessionId: session.id } },
    });
    if (!visit) {
      throw new BadRequestException('This school has no capture for the current session.');
    }
    return { visit: { id: visit.id, sessionId: visit.sessionId, status: visit[field] }, field };
  }
}
