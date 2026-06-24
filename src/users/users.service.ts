import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { AuditService } from '../audit/audit.service';
import { AccountStatus, Role, type Prisma } from '../generated/prisma/client';
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
  requiresPasswordChange: true,
  isServiceAccount: true,
  actionById: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

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
  ) {}

  async list(filters: { status?: string; role?: string; q?: string }) {
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
    return this.prisma.user.findMany({
      where,
      select: PUBLIC_SELECT,
      orderBy: { createdAt: 'desc' },
    });
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
