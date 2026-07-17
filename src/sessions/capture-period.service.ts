import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateCapturePeriodDto,
  UpdateCapturePeriodDto,
} from './dto/capture-period.dto';

const toDate = (v?: string | null) => (v ? new Date(v) : null);

// Capture periods (rounds) within a session. Mirrors SessionsService: exactly one
// period per session is `isCurrent` (the live capture target); activating a new
// one closes the previous (`closedAt`), which makes it read-only history.
@Injectable()
export class CapturePeriodService {
  constructor(private prisma: PrismaService) {}

  listForSession(sessionId: string) {
    return this.prisma.capturePeriod.findMany({
      where: { sessionId },
      orderBy: [{ sequence: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async create(sessionId: string, dto: CreateCapturePeriodDto) {
    await this.requireSessionExists(sessionId);
    try {
      // A session's first period is current by default; later ones start pending
      // until explicitly activated.
      const isFirst =
        (await this.prisma.capturePeriod.count({ where: { sessionId } })) === 0;
      return await this.prisma.capturePeriod.create({
        data: {
          sessionId,
          name: dto.name,
          sequence: dto.sequence ?? 1,
          startDate: toDate(dto.startDate),
          endDate: toDate(dto.endDate),
          isCurrent: isFirst,
        },
      });
    } catch (e: any) {
      if (e?.code === 'P2002')
        throw new ConflictException(
          `A period named "${dto.name}" already exists in this session.`,
        );
      throw e;
    }
  }

  async update(id: string, dto: UpdateCapturePeriodDto) {
    const period = await this.requirePeriod(id);
    if (period.closedAt) {
      throw new BadRequestException('A closed period can no longer be edited.');
    }
    try {
      return await this.prisma.capturePeriod.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.sequence !== undefined ? { sequence: dto.sequence } : {}),
          ...(dto.startDate !== undefined
            ? { startDate: toDate(dto.startDate) }
            : {}),
          ...(dto.endDate !== undefined ? { endDate: toDate(dto.endDate) } : {}),
        },
      });
    } catch (e: any) {
      if (e?.code === 'P2002')
        throw new ConflictException(
          `A period named "${dto.name}" already exists in this session.`,
        );
      throw e;
    }
  }

  // Make one period current within its session; close whichever was current.
  async activate(id: string) {
    const period = await this.requirePeriod(id);
    await this.prisma.$transaction([
      // Close + demote the session's other current period(s).
      this.prisma.capturePeriod.updateMany({
        where: {
          sessionId: period.sessionId,
          isCurrent: true,
          NOT: { id },
        },
        data: { isCurrent: false, closedAt: new Date() },
      }),
      // Activate this one (re-opening it if it had been closed).
      this.prisma.capturePeriod.update({
        where: { id },
        data: { isCurrent: true, closedAt: null },
      }),
    ]);
    return this.prisma.capturePeriod.findUnique({ where: { id } });
  }

  async requirePeriod(id: string) {
    const p = await this.prisma.capturePeriod.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('Capture period not found.');
    return p;
  }

  private async requireSessionExists(sessionId: string) {
    const s = await this.prisma.session.findUnique({ where: { id: sessionId } });
    if (!s) throw new NotFoundException('Session not found.');
    return s;
  }
}
