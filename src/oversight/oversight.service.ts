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
import { NotificationsService } from '../notifications/notifications.service';
import { toCsv } from './security-export';
import { parsePage } from '../common/pagination';

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
    private notifications: NotificationsService,
  ) {}

  // ─── Submissions queue ──────────────────────────────────────────────────────
  async listSubmissions(
    user: RequestUser,
    opts: { page?: string; pageSize?: string } = {},
  ) {
    const session = await this.sessions.findCurrent();
    const period = await this.sessions.findCurrentPeriod();
    const scope = this.schools.scopeWhere(user);
    const empty = {
      session: session ? { id: session.id, name: session.name } : null,
      summary: { schoolsAwaiting: 0, sectionsAwaiting: 0 },
      items: [] as unknown[],
      total: 0,
      page: 1,
      pageSize: 25,
    };
    if (!session || !period || !scope) return empty;

    // Verification operates on the official inspector record for the current
    // period only; principal self-service submissions are a separate source.
    //
    // Queried from the visit side rather than the school side: only schools with
    // a SUBMITTED section belong on this screen, and expressing that as a filter
    // means the database returns the handful that qualify instead of every
    // school in scope for the server to discard.
    const submittedSomewhere = {
      periodId: period.id,
      source: CaptureSource.INSPECTOR,
      school: scope,
      OR: Object.values(FIELD).map((field) => ({
        [field]: CaptureStatus.SUBMITTED,
      })),
    };

    const params = parsePage(opts.page, opts.pageSize);
    const [visits, total, awaitingRows] = await this.prisma.$transaction([
      this.prisma.schoolVisit.findMany({
        where: submittedSomewhere,
        orderBy: { school: { name: 'asc' } },
        include: { school: true },
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.schoolVisit.count({ where: submittedSomewhere }),
      // The summary counts every outstanding section in scope, not just the
      // page being viewed — a total that changed as you paged would be useless.
      this.prisma.schoolVisit.findMany({
        where: submittedSomewhere,
        select: Object.fromEntries(
          Object.values(FIELD).map((f) => [f, true]),
        ) as Record<SectionField, true>,
      }),
    ]);

    const sectionsAwaiting = awaitingRows.reduce(
      (n, v) =>
        n +
        Object.values(FIELD).filter(
          (f) => (v as Record<string, unknown>)[f] === CaptureStatus.SUBMITTED,
        ).length,
      0,
    );

    const items = visits
      .map((visit) => {
        const s = visit.school;
        const v = visit;
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
      // schoolsAwaiting is the full count in scope, not items.length — that used
      // to be the same number and no longer is.
      summary: { schoolsAwaiting: total, sectionsAwaiting },
      items,
      total,
      page: params.page,
      pageSize: params.pageSize,
    };
  }

  // ─── Risk overview ──────────────────────────────────────────────────────────
  async riskOverview(
    user: RequestUser,
    opts: { page?: string; pageSize?: string; tier?: string } = {},
  ) {
    const session = await this.sessions.findCurrent();
    const period = await this.sessions.findCurrentPeriod();
    const scope = this.schools.scopeWhere(user);
    const tiers = { High: 0, Moderate: 0, Low: 0 };
    if (!session || !period || !scope) {
      return {
        session: session ? { id: session.id, name: session.name } : null,
        tiers,
        items: [] as unknown[],
        total: 0,
        page: 1,
        pageSize: 25,
      };
    }

    const where = {
      periodId: period.id,
      source: CaptureSource.INSPECTOR,
      recordStatus: { in: [CaptureStatus.SUBMITTED, CaptureStatus.VERIFIED] },
      school: scope,
    };

    // Tier filtering belongs on the server: applied in the browser it would
    // filter only the page on screen, so clicking "High" next to a card reading
    // 40 could show three rows.
    const listWhere =
      opts.tier && ['High', 'Moderate', 'Low'].includes(opts.tier)
        ? { ...where, riskTier: opts.tier }
        : where;

    const params = parsePage(opts.page, opts.pageSize);
    const [profiles, total] = await this.prisma.$transaction([
      this.prisma.schoolSecurityProfile.findMany({
        where: listWhere,
        include: {
          school: { select: { name: true, code: true, lgaName: true } },
        },
        orderBy: { compositeRiskScore: 'desc' },
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.schoolSecurityProfile.count({ where: listWhere }),
    ]);

    // Tier totals are the headline of this screen and must describe the whole
    // scope. Counting only the current page would make them shrink as you page —
    // grouping in the database keeps them whole and costs one query. Kept out of
    // the transaction above because groupBy loses its result typing inside one.
    const tierCounts = await this.prisma.schoolSecurityProfile.groupBy({
      by: ['riskTier'],
      where,
      _count: { riskTier: true },
    });

    for (const t of tierCounts) {
      if (t.riskTier && t.riskTier in tiers) {
        tiers[t.riskTier as keyof typeof tiers] = t._count.riskTier;
      }
    }

    const items = profiles.map((p) => {
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
        exposureScore: p.exposureScore,
        recordStatus: p.recordStatus,
      };
    });

    return {
      session: { id: session.id, name: session.name },
      tiers,
      items,
      total,
      page: params.page,
      pageSize: params.pageSize,
    };
  }

  // ─── CSV export ─────────────────────────────────────────────────────────────
  //
  // The full security dataset, flattened to one row per captured profile. Same
  // geographic scoping as every other read: a zonal coordinator exports their
  // zone, not the state.
  //
  // Both INSPECTOR and PRINCIPAL records are included (the risk overview shows
  // inspector records only, to avoid double-counting tiers). For analysis the
  // two are the point of comparison, so they come out together with a Source
  // column to separate them.
  async securityExport(
    user: RequestUser,
    periodId?: string,
  ): Promise<{ csv: string; filename: string; rows: number }> {
    const session = await this.sessions.findCurrent();
    const period = periodId
      ? await this.prisma.capturePeriod.findUnique({ where: { id: periodId } })
      : await this.sessions.findCurrentPeriod();
    const scope = this.schools.scopeWhere(user);

    if (!session || !period || !scope) {
      return {
        csv: toCsv([]),
        filename: 'neuron-security-export-empty.csv',
        rows: 0,
      };
    }

    const profiles = await this.prisma.schoolSecurityProfile.findMany({
      where: {
        periodId: period.id,
        recordStatus: {
          in: [CaptureStatus.SUBMITTED, CaptureStatus.VERIFIED],
        },
        school: scope,
      },
      include: {
        school: {
          select: {
            code: true,
            name: true,
            type: true,
            lgaName: true,
            lgaCode: true,
            zoneName: true,
            ward: true,
            community: true,
            latitude: true,
            longitude: true,
            gpsAccuracyMetres: true,
          },
        },
        collectedBy: {
          select: { firstName: true, lastName: true, email: true },
        },
      },
      orderBy: [{ school: { lgaName: 'asc' } }, { school: { name: 'asc' } }],
    });

    const rows = profiles.map((p) => ({
      ...p,
      schoolCode: p.school.code,
      schoolName: p.school.name,
      schoolType: p.school.type,
      lgaName: p.school.lgaName,
      lgaCode: p.school.lgaCode,
      zoneName: p.school.zoneName,
      ward: p.school.ward,
      community: p.school.community,
      latitude: p.school.latitude,
      longitude: p.school.longitude,
      gpsAccuracyMetres: p.school.gpsAccuracyMetres,
      sessionName: session.name,
      periodName: period.name,
      collectedByName: p.collectedBy
        ? `${p.collectedBy.firstName ?? ''} ${p.collectedBy.lastName ?? ''}`.trim()
        : '',
      collectedByEmail: p.collectedBy?.email ?? '',
    }));

    // Session names carry a slash ("2025/2026"), which is a path separator in a
    // filename on every platform that matters.
    const slug = (s: string) =>
      s
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .toLowerCase();

    return {
      csv: toCsv(rows),
      filename: `neuron-security-${slug(session.name)}-${slug(period.name)}.csv`,
      rows: rows.length,
    };
  }

  // A bulk download of school vulnerability data is exactly the kind of action
  // that needs a name against it afterwards.
  async recordExport(user: RequestUser, filename: string, rows: number) {
    await this.audit.log({
      actorId: user.id,
      action: 'SECURITY_DATA_EXPORTED',
      targetType: 'EXPORT',
      targetLabel: filename,
      metadata: { rows, format: 'csv' },
    });
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

    await this.notifyInspector(visit, schoolId, {
      type: 'SECTION_VERIFIED',
      title: `${SECTION_LABEL[section]} verified`,
      bodyFor: (school) =>
        `Your ${SECTION_LABEL[section]} submission for ${school} has been verified by a supervisor. No further action is needed.`,
      section,
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

    await this.notifyInspector(visit, schoolId, {
      type: 'SECTION_RETURNED',
      title: `${SECTION_LABEL[section]} returned for revision`,
      bodyFor: (school) =>
        `A supervisor has sent your ${SECTION_LABEL[section]} submission for ${school} back for revision. Open it, make the corrections and submit again.`,
      section,
    });

    return { message: `${SECTION_LABEL[section]} returned for revision.` };
  }

  /**
   * Tell whoever captured a section what a supervisor decided about it.
   * Best-effort: an unassigned visit has nobody to notify.
   */
  private async notifyInspector(
    visit: { id: string; periodId: string },
    schoolId: string,
    copy: {
      type: 'SECTION_VERIFIED' | 'SECTION_RETURNED';
      title: string;
      bodyFor: (schoolName: string) => string;
      section: SectionKey;
    },
  ) {
    const [row, school] = await Promise.all([
      this.prisma.schoolVisit.findUnique({
        where: { id: visit.id },
        select: { inspectorId: true },
      }),
      this.prisma.school.findUnique({
        where: { id: schoolId },
        select: { name: true },
      }),
    ]);
    if (!row?.inspectorId) return;

    await this.notifications.notify({
      userId: row.inspectorId,
      type: copy.type,
      title: copy.title,
      body: copy.bodyFor(school?.name ?? 'the school'),
      link: `/schools/${schoolId}/${copy.section}`,
    });
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
