import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { parsePage, paged } from '../common/pagination';
import { MailService } from '../mail/mail.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  AccountStatus,
  Role,
  type NotificationType,
  type Prisma,
} from '../generated/prisma/client';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import slugify from 'slugify';
import {
  ProvisionUserDto,
  ApproveUserDto,
  RejectUserDto,
  UpdateUserDto,
  StatusActionDto,
} from './dto/user.dto';

// Never leak secrets (password, refreshToken, OTP) in admin responses.
const PUBLIC_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  username: true,
  email: true,
  phoneNumber: true,
  role: true,
  accountStatus: true,
  accountStatusReason: true,
  assignedLga: true,
  assignedZone: true,
  assignedCluster: true,
  assignedSchoolId: true,
  requiresPasswordChange: true,
  isServiceAccount: true,
  actionById: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

// Wording the affected person actually receives, per action.
const STATUS_NOTIFICATION: Record<
  string,
  { type: NotificationType; title: string; body: string }
> = {
  SUSPEND: {
    type: 'ACCOUNT_SUSPENDED',
    title: 'Your account has been suspended',
    body: 'A system administrator has paused your access to NEURON. You have been signed out and cannot sign in until the suspension is lifted.',
  },
  BAN: {
    type: 'ACCOUNT_BANNED',
    title: 'Your account has been banned',
    body: 'A system administrator has permanently revoked your access to NEURON.',
  },
  DEACTIVATE: {
    type: 'ACCOUNT_DEACTIVATED',
    title: 'Your account has been deactivated',
    body: 'Your NEURON account has been closed. If you need access again, a system administrator can reactivate it.',
  },
  REACTIVATE: {
    type: 'ACCOUNT_REACTIVATED',
    title: 'Your account has been reactivated',
    body: 'Your access to NEURON has been restored. You can sign in again straight away.',
  },
};

const STATUS_BY_ACTION: Record<string, AccountStatus> = {
  SUSPEND: AccountStatus.SUSPENDED,
  REACTIVATE: AccountStatus.ACTIVE,
  BAN: AccountStatus.BANNED,
  DEACTIVATE: AccountStatus.DEACTIVATED,
};

@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    private mail: MailService,
    private audit: AuditService,
    private notifications: NotificationsService,
  ) {}

  async list(filters: {
    status?: string;
    role?: string;
    q?: string;
    page?: string;
    pageSize?: string;
  }) {
    const where: Prisma.UserWhereInput = {};
    if (filters.status) where.accountStatus = filters.status as AccountStatus;
    if (filters.role) where.role = filters.role as Role;
    if (filters.q) {
      where.OR = [
        { firstName: { contains: filters.q, mode: 'insensitive' } },
        { lastName: { contains: filters.q, mode: 'insensitive' } },
        { email: { contains: filters.q, mode: 'insensitive' } },
      ];
    }
    // Filters apply before the page is cut, so the count reflects the search the
    // user actually ran rather than the whole table.
    const params = parsePage(filters.page, filters.pageSize);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: PUBLIC_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.user.count({ where }),
    ]);
    return paged(rows, total, params);
  }

  async pendingCount() {
    return {
      pending: await this.prisma.user.count({
        where: { accountStatus: AccountStatus.PENDING },
      }),
    };
  }

  async getOne(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: PUBLIC_SELECT,
    });
    if (!user) throw new NotFoundException('User not found.');
    return user;
  }


  /**
   * Everything an administrator needs to judge one account in a single view:
   * who they are, who provisioned them, the school they are bound to (principals)
   * or the area they cover, what they have captured, and the trail of admin
   * actions taken on them or by them.
   *
   * Approving or suspending someone you can't inspect is a guess; this is what
   * turns it into a decision.
   */
  async getDetail(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: PUBLIC_SELECT,
    });
    if (!user) throw new NotFoundException('User not found.');

    const [actionBy, school, visits, mediaCount, activity, performed] =
      await Promise.all([
        // The administrator who provisioned / approved / rejected this account.
        user.actionById
          ? this.prisma.user.findUnique({
              where: { id: user.actionById },
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                role: true,
              },
            })
          : Promise.resolve(null),

        // PRINCIPAL accounts are bound to exactly one school.
        user.assignedSchoolId
          ? this.prisma.school.findUnique({
              where: { id: user.assignedSchoolId },
              select: {
                id: true,
                code: true,
                name: true,
                lgaName: true,
                zoneName: true,
                isActive: true,
              },
            })
          : Promise.resolve(null),

        // Capture work: the visits this user is the inspector of record for.
        this.prisma.schoolVisit.findMany({
          where: { inspectorId: id },
          orderBy: { updatedAt: 'desc' },
          take: 25,
          select: {
            id: true,
            overallStatus: true,
            updatedAt: true,
            school: { select: { id: true, code: true, name: true, lgaName: true } },
          },
        }),

        this.prisma.schoolMedia.count({ where: { uploadedById: id } }),

        // Administrative actions taken ON this account.
        this.prisma.auditLog.findMany({
          where: { targetType: 'USER', targetId: id },
          orderBy: { createdAt: 'desc' },
          take: 25,
        }),

        // Administrative actions taken BY this account (relevant for supervisors).
        this.prisma.auditLog.findMany({
          where: { actorId: id },
          orderBy: { createdAt: 'desc' },
          take: 25,
        }),
      ]);

    const byStatus = await this.prisma.schoolVisit.groupBy({
      by: ['overallStatus'],
      where: { inspectorId: id },
      _count: { _all: true },
    });

    return {
      user,
      actionBy,
      school,
      stats: {
        visits: byStatus.reduce((sum, r) => sum + r._count._all, 0),
        byStatus: Object.fromEntries(
          byStatus.map((r) => [r.overallStatus, r._count._all]),
        ),
        mediaUploaded: mediaCount,
      },
      visits,
      // Actions taken on the account (approvals, suspensions, role changes).
      history: activity,
      // Actions this user performed, for supervisor and admin roles.
      performed,
    };
  }

  async provision(adminId: string, dto: ProvisionUserDto) {
    const clash = await this.prisma.user.findFirst({
      where: { OR: [{ email: dto.email }, { phoneNumber: dto.phoneNumber }] },
      select: { id: true },
    });
    if (clash) {
      throw new ConflictException(
        'A user with this email or phone number already exists.',
      );
    }

    const tempPassword = this.generateTempPassword();
    const password = await bcrypt.hash(tempPassword, 10);
    const username = await this.uniqueUsername(dto.firstName, dto.lastName);

    const user = await this.prisma.user.create({
      data: {
        firstName: dto.firstName,
        lastName: dto.lastName,
        email: dto.email,
        phoneNumber: dto.phoneNumber,
        username,
        password,
        role: dto.role as Role,
        accountStatus: AccountStatus.ACTIVE,
        requiresPasswordChange: true,
        assignedLga: dto.assignedLga ?? null,
        assignedZone: dto.assignedZone ?? null,
        assignedCluster: dto.assignedCluster ?? null,
        assignedSchoolId: dto.assignedSchoolId ?? null,
        actionById: adminId,
      },
      select: PUBLIC_SELECT,
    });

    this.mail
      .sendWelcomeEmail(user.email, user.username, tempPassword, user.firstName)
      .catch(() => {});

    await this.audit.log({
      actorId: adminId,
      action: 'USER_PROVISIONED',
      targetType: 'USER',
      targetId: user.id,
      targetLabel: user.email,
      metadata: { role: user.role },
    });

    // The temp password is returned ONCE so the admin can relay it if email fails.
    return { user, tempPassword };
  }

  async approve(adminId: string, id: string, dto: ApproveUserDto) {
    const target = await this.requireUser(id);
    if (target.accountStatus !== AccountStatus.PENDING) {
      throw new BadRequestException('Only pending accounts can be approved.');
    }
    const user = await this.prisma.user.update({
      where: { id },
      data: {
        accountStatus: AccountStatus.ACTIVE,
        role: dto.role as Role,
        assignedLga: dto.assignedLga ?? null,
        assignedZone: dto.assignedZone ?? null,
        assignedCluster: dto.assignedCluster ?? null,
        assignedSchoolId: dto.assignedSchoolId ?? null,
        accountStatusReason: null,
        actionById: adminId,
      },
      select: PUBLIC_SELECT,
    });
    this.mail
      .sendStaffApprovalEmail(
        user.email,
        `${user.firstName} ${user.lastName}`,
        user.role,
      )
      .catch(() => {});
    await this.audit.log({
      actorId: adminId,
      action: 'USER_APPROVED',
      targetType: 'USER',
      targetId: user.id,
      targetLabel: user.email,
      metadata: { role: user.role, assignedLga: user.assignedLga },
    });

    // The approval email already went out above; this adds the in-app record so
    // the notification centre reflects the same events the inbox does.
    await this.notifications.notify({
      userId: user.id,
      type: 'ACCOUNT_APPROVED',
      title: 'Your account has been approved',
      body: `Your NEURON account is active. You have been assigned the ${user.role.replace(/_/g, ' ')} role.`,
      link: '/',
      forceEmail: false,
    });

    return user;
  }

  async reject(adminId: string, id: string, dto: RejectUserDto) {
    const target = await this.requireUser(id);
    if (target.accountStatus !== AccountStatus.PENDING) {
      throw new BadRequestException('Only pending accounts can be rejected.');
    }
    const user = await this.prisma.user.update({
      where: { id },
      data: {
        accountStatus: AccountStatus.REJECTED,
        accountStatusReason: dto.reason ?? null,
        actionById: adminId,
      },
      select: PUBLIC_SELECT,
    });
    this.mail
      .sendStaffRejectionEmail(
        user.email,
        `${user.firstName} ${user.lastName}`,
        user.role,
        dto.reason,
      )
      .catch(() => {});
    await this.audit.log({
      actorId: adminId,
      action: 'USER_REJECTED',
      targetType: 'USER',
      targetId: user.id,
      targetLabel: user.email,
      metadata: { reason: dto.reason ?? null },
    });

    await this.notifications.notify({
      userId: user.id,
      type: 'ACCOUNT_REJECTED',
      title: 'Your registration was not approved',
      body: dto.reason?.trim()
        ? `A system administrator reviewed your registration and did not approve it. Reason given: “${dto.reason.trim()}”.`
        : 'A system administrator reviewed your registration and did not approve it.',
      forceEmail: false,
    });

    return user;
  }

  async updateRoleScope(adminId: string, id: string, dto: UpdateUserDto) {
    this.assertNotSelf(adminId, id, 'change your own role');
    const target = await this.requireUser(id);

    // Demoting the last active admin would lock everyone out of admin functions.
    if (
      target.role === Role.SYS_ADMIN &&
      dto.role !== Role.SYS_ADMIN
    ) {
      await this.assertAnotherActiveAdminExists(id);
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        role: dto.role as Role,
        assignedLga: dto.assignedLga ?? null,
        assignedZone: dto.assignedZone ?? null,
        assignedCluster: dto.assignedCluster ?? null,
        assignedSchoolId: dto.assignedSchoolId ?? null,
        actionById: adminId,
      },
      select: PUBLIC_SELECT,
    });
    await this.audit.log({
      actorId: adminId,
      action: 'USER_ROLE_CHANGED',
      targetType: 'USER',
      targetId: id,
      targetLabel: updated.email,
      metadata: { role: updated.role, assignedLga: updated.assignedLga },
    });

    await this.notifications.notify({
      userId: id,
      type: 'ROLE_CHANGED',
      title: 'Your role has been updated',
      body: `A system administrator changed your role to ${updated.role.replace(/_/g, ' ')}. What you can see and do in NEURON has changed accordingly.`,
      link: '/',
    });

    return updated;
  }

  async changeStatus(adminId: string, id: string, dto: StatusActionDto) {
    this.assertNotSelf(adminId, id, 'change your own account status');
    const target = await this.requireUser(id);
    const nextStatus = STATUS_BY_ACTION[dto.action];

    // Don't let the last active admin be suspended/banned/deactivated.
    if (
      target.role === Role.SYS_ADMIN &&
      nextStatus !== AccountStatus.ACTIVE
    ) {
      await this.assertAnotherActiveAdminExists(id);
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        accountStatus: nextStatus,
        accountStatusReason:
          nextStatus === AccountStatus.ACTIVE ? null : (dto.reason ?? null),
        actionById: adminId,
        // Revoke any live session when access is removed.
        ...(nextStatus === AccountStatus.ACTIVE ? {} : { refreshToken: null }),
      },
      select: PUBLIC_SELECT,
    });
    await this.audit.log({
      actorId: adminId,
      action: 'USER_STATUS_CHANGED',
      targetType: 'USER',
      targetId: id,
      targetLabel: updated.email,
      metadata: { action: dto.action, status: nextStatus, reason: dto.reason ?? null },
    });

    // Tell them, in the app and by email. Being suspended without being told is
    // the single worst version of this flow — the reason the administrator typed
    // is carried through verbatim.
    const copy = STATUS_NOTIFICATION[dto.action];
    await this.notifications.notify({
      userId: id,
      type: copy.type,
      title: copy.title,
      body: dto.reason?.trim()
        ? `${copy.body} Reason given: “${dto.reason.trim()}”.`
        : copy.body,
    });

    return updated;
  }

  async resetPassword(adminId: string, id: string) {
    const user = await this.requireUser(id);
    const tempPassword = this.generateTempPassword();
    const password = await bcrypt.hash(tempPassword, 10);
    await this.prisma.user.update({
      where: { id },
      data: {
        password,
        requiresPasswordChange: true,
        refreshToken: null,
        actionById: adminId,
      },
    });
    this.mail
      .sendWelcomeEmail(user.email, user.username, tempPassword, user.firstName)
      .catch(() => {});
    await this.audit.log({
      actorId: adminId,
      action: 'USER_PASSWORD_RESET',
      targetType: 'USER',
      targetId: id,
      targetLabel: user.email,
    });

    await this.notifications.notify({
      userId: id,
      type: 'PASSWORD_RESET',
      title: 'Your password was reset',
      body: 'A system administrator reset your password. Use the temporary password you were given, and choose a new one when you sign in.',
    });

    return { tempPassword };
  }

  // ─── helpers ──────────────────────────────────────────────────────────────

  private async requireUser(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found.');
    return user;
  }

  private assertNotSelf(adminId: string, targetId: string, action: string) {
    if (adminId === targetId) {
      throw new ForbiddenException(`You cannot ${action}.`);
    }
  }

  private async assertAnotherActiveAdminExists(excludeId: string) {
    const others = await this.prisma.user.count({
      where: {
        role: Role.SYS_ADMIN,
        accountStatus: AccountStatus.ACTIVE,
        id: { not: excludeId },
      },
    });
    if (others === 0) {
      throw new BadRequestException(
        'At least one active administrator must remain.',
      );
    }
  }

  private generateTempPassword() {
    // e.g. "Neuron-9f3a2b7c" — meets the 8-char minimum; changed on first login.
    return `Neuron-${randomBytes(4).toString('hex')}`;
  }

  private async uniqueUsername(firstName: string, lastName: string) {
    const base = slugify(`${firstName} ${lastName}`, {
      lower: true,
      strict: true,
    });
    for (let i = 0; i < 5; i++) {
      const candidate = `${base}-${Math.random().toString(36).slice(2, 6)}`;
      const exists = await this.prisma.user.findUnique({
        where: { username: candidate },
        select: { id: true },
      });
      if (!exists) return candidate;
    }
    return `${base}-${randomBytes(3).toString('hex')}`;
  }
}
