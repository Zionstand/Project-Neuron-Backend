import { Injectable } from '@nestjs/common';
import { SchoolsService, type RequestUser } from '../schools/schools.service';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from '../sessions/sessions.service';
import { CaptureStatus } from '../generated/prisma/client';

@Injectable()
export class DashboardService {
  constructor(
    private schools: SchoolsService,
    private prisma: PrismaService,
    private sessions: SessionsService,
  ) {}

  // Field-inspector home summary: progress of the caller's assigned schools for
  // the current session. Built from the same scoped worklist the schools list
  // uses, so the counts and the table can never disagree.
  async lieSummary(user: RequestUser) {
    const { session, schools } = await this.schools.listForUser(user);

    const counts = {
      total: schools.length,
      notStarted: 0,
      inProgress: 0, // DRAFT
      submitted: 0,
      verified: 0,
    };

    for (const s of schools) {
      switch (s.status) {
        case 'DRAFT':
          counts.inProgress++;
          break;
        case 'SUBMITTED':
          counts.submitted++;
          break;
        case 'VERIFIED':
          counts.verified++;
          break;
        default:
          counts.notStarted++;
      }
    }

    const completed = counts.submitted + counts.verified;

    return {
      session,
      assignedLga: user.assignedLga,
      assignedCluster: user.assignedCluster,
      counts,
      completed,
      completionRate: counts.total
        ? Math.round((completed / counts.total) * 100)
        : 0,
    };
  }

  // State-wide (scoped) overview for SYS_ADMIN / leadership roles.
  async adminSummary(user: RequestUser) {
    const session = await this.sessions.findCurrent();
    const scope = this.schools.scopeWhere(user);

    const blank = {
      session: session ? { id: session.id, name: session.name } : null,
      totals: { schools: 0, activeInspectors: 0, enrolment: 0 },
      capture: { notStarted: 0, draft: 0, submitted: 0, verified: 0, completionRate: 0 },
      verification: { schoolsAwaiting: 0, sectionsAwaiting: 0 },
      risk: { High: 0, Moderate: 0, Low: 0 },
      byLga: [] as Array<{ lga: string; schools: number; completed: number; completionRate: number }>,
    };
    if (!scope) return blank;

    const schools = await this.prisma.school.findMany({
      where: scope,
      select: { id: true, lgaName: true },
    });
    const ids = schools.map((s) => s.id);
    const total = schools.length;

    const activeInspectors = await this.prisma.user.count({
      where: { role: 'LIE', accountStatus: 'ACTIVE' },
    });

    if (!session || total === 0) {
      return { ...blank, totals: { schools: total, activeInspectors, enrolment: 0 } };
    }

    const visits = await this.prisma.schoolVisit.findMany({
      where: { sessionId: session.id, schoolId: { in: ids } },
      select: {
        schoolId: true,
        overallStatus: true,
        ascStatus: true,
        studentsStatus: true,
        staffStatus: true,
        securityStatus: true,
        mediaStatus: true,
      },
    });
    const overallBySchool = new Map(visits.map((v) => [v.schoolId, v.overallStatus]));

    const capture = { notStarted: 0, draft: 0, submitted: 0, verified: 0, completionRate: 0 };
    // Per-LGA tally.
    const lgaMap = new Map<string, { schools: number; completed: number }>();
    for (const s of schools) {
      const status = overallBySchool.get(s.id) ?? CaptureStatus.NOT_STARTED;
      if (status === CaptureStatus.DRAFT) capture.draft++;
      else if (status === CaptureStatus.SUBMITTED) capture.submitted++;
      else if (status === CaptureStatus.VERIFIED) capture.verified++;
      else capture.notStarted++;

      const lga = lgaMap.get(s.lgaName) ?? { schools: 0, completed: 0 };
      lga.schools++;
      if (status === CaptureStatus.SUBMITTED || status === CaptureStatus.VERIFIED) {
        lga.completed++;
      }
      lgaMap.set(s.lgaName, lga);
    }
    const completed = capture.submitted + capture.verified;
    capture.completionRate = total ? Math.round((completed / total) * 100) : 0;

    // Verification backlog.
    let sectionsAwaiting = 0;
    let schoolsAwaiting = 0;
    for (const v of visits) {
      const submitted = [
        v.ascStatus,
        v.studentsStatus,
        v.staffStatus,
        v.securityStatus,
        v.mediaStatus,
      ].filter((s) => s === CaptureStatus.SUBMITTED).length;
      if (submitted > 0) {
        schoolsAwaiting++;
        sectionsAwaiting += submitted;
      }
    }

    // Risk tiers from submitted/verified security profiles.
    const profiles = await this.prisma.schoolSecurityProfile.findMany({
      where: {
        sessionId: session.id,
        schoolId: { in: ids },
        recordStatus: { in: [CaptureStatus.SUBMITTED, CaptureStatus.VERIFIED] },
      },
      select: { riskTier: true },
    });
    const risk = { High: 0, Moderate: 0, Low: 0 };
    for (const p of profiles) {
      if (p.riskTier && p.riskTier in risk) risk[p.riskTier as keyof typeof risk]++;
    }

    // Total enrolment captured this session.
    const enrolAgg = await this.prisma.ascRecord.aggregate({
      where: { sessionId: session.id, schoolId: { in: ids } },
      _sum: { enrolmentCount: true },
    });

    const byLga = Array.from(lgaMap.entries())
      .map(([lga, v]) => ({
        lga,
        schools: v.schools,
        completed: v.completed,
        completionRate: v.schools ? Math.round((v.completed / v.schools) * 100) : 0,
      }))
      .sort((a, b) => b.schools - a.schools);

    return {
      session: { id: session.id, name: session.name },
      totals: {
        schools: total,
        activeInspectors,
        enrolment: enrolAgg._sum.enrolmentCount ?? 0,
      },
      capture,
      verification: { schoolsAwaiting, sectionsAwaiting },
      risk,
      byLga,
    };
  }
}
