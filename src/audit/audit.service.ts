import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { Prisma } from '../generated/prisma/client';

export interface AuditEntry {
  actorId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  targetLabel?: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private prisma: PrismaService) {}

  // Best-effort: an audit failure must never break the underlying action.
  async log(entry: AuditEntry): Promise<void> {
    try {
      let actorName: string | null = null;
      let actorRole: string | null = null;
      if (entry.actorId) {
        const u = await this.prisma.user.findUnique({
          where: { id: entry.actorId },
          select: { firstName: true, lastName: true, role: true },
        });
        if (u) {
          actorName = `${u.firstName} ${u.lastName}`;
          actorRole = u.role;
        }
      }
      await this.prisma.auditLog.create({
        data: {
          actorId: entry.actorId ?? null,
          actorName,
          actorRole,
          action: entry.action,
          targetType: entry.targetType ?? null,
          targetId: entry.targetId ?? null,
          targetLabel: entry.targetLabel ?? null,
          ...(entry.metadata
            ? { metadata: entry.metadata as Prisma.InputJsonValue }
            : {}),
        },
      });
    } catch (e) {
      this.logger.warn(`Audit log write failed: ${(e as Error).message}`);
    }
  }

  async list(filters: { action?: string; actorId?: string; take?: number; skip?: number }) {
    const where: { action?: string; actorId?: string } = {};
    if (filters.action) where.action = filters.action;
    if (filters.actorId) where.actorId = filters.actorId;
    const take = Math.min(filters.take ?? 100, 200);
    const skip = filters.skip ?? 0;
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { rows, total };
  }
}
