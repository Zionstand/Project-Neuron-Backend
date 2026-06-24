import {
  Injectable,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSessionDto, UpdateSessionDto } from './dto/session.dto';

const toDate = (v?: string | null) => (v ? new Date(v) : null);

@Injectable()
export class SessionsService {
  constructor(private prisma: PrismaService) {}

  // The single session flagged Is_Current (Field Capture Guide §1.3). Capture
  // records auto-attach to it, so the LIE dashboard always works against it.
  async findCurrent() {
    return this.prisma.session.findFirst({ where: { isCurrent: true } });
  }

  async getCurrentOrThrow() {
    const session = await this.findCurrent();
    if (!session) {
      throw new NotFoundException(
        'No active academic session has been configured yet.',
      );
    }
    return session;
  }

  // ─── Admin management ───────────────────────────────────────────────────────

  listAll() {
    return this.prisma.session.findMany({ orderBy: { name: 'desc' } });
  }

  async create(dto: CreateSessionDto) {
    try {
      // Creating a session as "current" demotes whichever was current.
      if (dto.isCurrent) {
        await this.prisma.session.updateMany({
          where: { isCurrent: true },
          data: { isCurrent: false },
        });
      }
      return await this.prisma.session.create({
        data: {
          name: dto.name,
          startDate: toDate(dto.startDate),
          endDate: toDate(dto.endDate),
          isCurrent: dto.isCurrent ?? false,
        },
      });
    } catch (e: any) {
      if (e?.code === 'P2002')
        throw new ConflictException(`A session named "${dto.name}" already exists.`);
      throw e;
    }
  }

  async update(id: string, dto: UpdateSessionDto) {
    await this.requireSession(id);
    try {
      return await this.prisma.session.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.startDate !== undefined
            ? { startDate: toDate(dto.startDate) }
            : {}),
          ...(dto.endDate !== undefined ? { endDate: toDate(dto.endDate) } : {}),
        },
      });
    } catch (e: any) {
      if (e?.code === 'P2002')
        throw new ConflictException(`A session named "${dto.name}" already exists.`);
      throw e;
    }
  }

  // Make exactly one session current.
  async activate(id: string) {
    await this.requireSession(id);
    await this.prisma.$transaction([
      this.prisma.session.updateMany({
        where: { isCurrent: true, NOT: { id } },
        data: { isCurrent: false },
      }),
      this.prisma.session.update({ where: { id }, data: { isCurrent: true } }),
    ]);
    return this.prisma.session.findUnique({ where: { id } });
  }

  private async requireSession(id: string) {
    const s = await this.prisma.session.findUnique({ where: { id } });
    if (!s) throw new NotFoundException('Session not found.');
    return s;
  }
}
