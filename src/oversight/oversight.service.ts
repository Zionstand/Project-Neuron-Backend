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
import { CaptureStatus, CaptureSource } from '../generated/prisma/client';
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
    const period = await this.sessions.findCurrentPeriod();
    const scope = this.schools.scopeWhere(user);
    const empty = {
      session: session ? { id: session.id, name: session.name } : null,
      summary: { schoolsAwaiting: 0, sectionsAwaiting: 0 },
      items: [] as unknown[],
    };
    if (!session || !period || !scope) return empty;

    // Verification operates on the official inspector record for the current
    // period only; principal self-service submissions are a separate source.
    const schools = await this.prisma.school.findMany({
      where: scope,
      orderBy: { name: 'asc' },
      include: {
        visits: {
          where: { periodId: period.id, source: CaptureSource.INSPECTOR },
          take: 1,
        },
      },
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
    const period = await this.sessions.findCurrentPeriod();
    const scope = this.schools.scopeWhere(user);
    const tiers = { High: 0, Moderate: 0, Low: 0 };
    if (!session || !period || !scope) {
      return {
        session: session ? { id: session.id, name: session.name } : null,
        tiers,
        items: [] as unknown[],
      };
    }

    const profiles = await this.prisma.schoolSecurityProfile.findMany({
      where: {
        periodId: period.id,
        source: CaptureSource.INSPECTOR,
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
        where: {
          schoolId,
          periodId: visit.periodId,
          source: CaptureSource.INSPECTOR,
        },
        data: { recordStatus: CaptureStatus.VERIFIED },
      });
    }
    // Stamp Verified_By / Verification_Date on the section's fact rows (guide §).
    await this.stampVerifier(section, schoolId, visit.periodId, user.id);
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
        where: {
          schoolId,
          periodId: visit.periodId,
          source: CaptureSource.INSPECTOR,
        },
        data: { recordStatus: CaptureStatus.DRAFT },
      });
    }
    // Clear the verification stamp when a section is sent back.
    await this.stampVerifier(section, schoolId, visit.periodId, null);
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

  // Supervisor flag on a single media file (Field Capture Guide §6). A non-empty
  // reason flags it; an empty reason clears the flag.
  async flagMedia(
    user: RequestUser,
    schoolId: string,
    mediaId: string,
    reason?: string,
  ) {
    await this.schools.requireScopedSchool(user, schoolId);
    const media = await this.prisma.schoolMedia.findFirst({
      where: { id: mediaId, schoolId },
      select: { id: true },
    });
    if (!media) throw new BadRequestException('Media file not found.');
    const flagged = !!reason?.trim();
    await this.prisma.schoolMedia.update({
      where: { id: mediaId },
      data: {
        isFlagged: flagged,
        flagReason: flagged ? reason!.trim() : null,
      },
    });
    await this.audit.log({
      actorId: user.id,
      action: flagged ? 'MEDIA_FLAGGED' : 'MEDIA_UNFLAGGED',
      targetType: 'MEDIA',
      targetId: mediaId,
      targetLabel: schoolId,
      metadata: { reason: reason ?? null },
    });
    return { message: flagged ? 'Media flagged.' : 'Flag cleared.' };
  }

  // Stamp (or clear, when actorId is null) Verified_By / Verification_Date on all
  // INSPECTOR-source fact rows of a section for a school+period. Mirrors the guide's
  // per-record verification fields.
  private async stampVerifier(
    section: SectionKey,
    schoolId: string,
    periodId: string,
    actorId: string | null,
  ) {
    const where = {
      schoolId,
      periodId,
      source: CaptureSource.INSPECTOR,
    };
    const data = {
      verifiedById: actorId,
      verifiedAt: actorId ? new Date() : null,
    };
    switch (section) {
      case 'asc':
        await this.prisma.ascRecord.updateMany({ where, data });
        break;
      case 'students':
        await this.prisma.studentRecord.updateMany({ where, data });
        break;
      case 'staff':
        await this.prisma.staffRecord.updateMany({ where, data });
        break;
      case 'security':
        await this.prisma.schoolSecurityProfile.updateMany({ where, data });
        break;
      case 'media':
        await this.prisma.schoolMedia.updateMany({ where, data });
        break;
    }
  }

  private async locateSection(
    user: RequestUser,
    schoolId: string,
    section: SectionKey,
  ) {
    await this.schools.requireScopedSchool(user, schoolId);
    const period = await this.sessions.getCurrentPeriodOrThrow();
    const field = FIELD[section];
    const visit = await this.prisma.schoolVisit.findUnique({
      where: {
        schoolId_periodId_source: {
          schoolId,
          periodId: period.id,
          source: CaptureSource.INSPECTOR,
        },
      },
    });
    if (!visit) {
      throw new BadRequestException('This school has no capture for the current period.');
    }
    return {
      visit: {
        id: visit.id,
        sessionId: visit.sessionId,
        periodId: visit.periodId,
        status: visit[field],
      },
      field,
    };
  }
}
