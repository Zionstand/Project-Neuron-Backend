import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { Prisma } from '../generated/prisma/client';
import {
  CreateReferenceDto,
  UpdateReferenceDto,
  type ReferenceKind,
} from './dto/reference.dto';

// Maps a reference kind → its Prisma model delegate + default ordering. The six
// dimension tables share one CRUD surface; only the fields differ.
@Injectable()
export class ReferenceService {
  constructor(private prisma: PrismaService) {}

  private delegate(kind: ReferenceKind): {
    model: any;
    orderBy: Prisma.Enumerable<any>;
  } {
    switch (kind) {
      case 'zones':
        return { model: this.prisma.zone, orderBy: { name: 'asc' } };
      case 'lgas':
        return { model: this.prisma.lga, orderBy: { name: 'asc' } };
      case 'class-levels':
        return { model: this.prisma.classLevel, orderBy: { sortOrder: 'asc' } };
      case 'qualifications':
        return { model: this.prisma.qualificationType, orderBy: { rank: 'asc' } };
      case 'subjects':
        return { model: this.prisma.subjectArea, orderBy: { name: 'asc' } };
      case 'media-categories':
        return { model: this.prisma.mediaCategory, orderBy: { code: 'asc' } };
      default:
        throw new BadRequestException('Unknown reference type.');
    }
  }

  // List rows for a kind. `activeOnly` (default true) is what capture dropdowns use.
  list(kind: ReferenceKind, activeOnly = true) {
    const { model, orderBy } = this.delegate(kind);
    return model.findMany({
      where: activeOnly ? { isActive: true } : {},
      orderBy,
    });
  }

  // Build the create/update payload valid for the given kind, ignoring fields that
  // don't belong to it.
  private shape(kind: ReferenceKind, dto: CreateReferenceDto | UpdateReferenceDto) {
    const common: Record<string, unknown> = {};
    if (dto.name !== undefined) common.name = dto.name;
    if ((dto as UpdateReferenceDto).isActive !== undefined) {
      common.isActive = (dto as UpdateReferenceDto).isActive;
    }
    switch (kind) {
      case 'zones':
        return { ...common, ...(dto.code !== undefined ? { code: dto.code } : {}) };
      case 'lgas':
        return {
          ...common,
          ...(dto.code !== undefined ? { code: dto.code } : {}),
          ...(dto.zoneId !== undefined ? { zoneId: dto.zoneId || null } : {}),
        };
      case 'class-levels':
        return {
          ...common,
          ...(dto.code !== undefined ? { code: dto.code } : {}),
          ...(dto.educationLevel !== undefined ? { educationLevel: dto.educationLevel } : {}),
          ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        };
      case 'qualifications':
        return {
          ...common,
          ...(dto.code !== undefined ? { code: dto.code } : {}),
          ...(dto.rank !== undefined ? { rank: dto.rank } : {}),
        };
      case 'subjects':
        return {
          ...common,
          ...(dto.category !== undefined ? { category: dto.category || null } : {}),
        };
      case 'media-categories':
        return {
          ...common,
          ...(dto.code !== undefined ? { code: dto.code } : {}),
          ...(dto.appliesToModule !== undefined ? { appliesToModule: dto.appliesToModule } : {}),
          ...(dto.mediaTypeAllowed !== undefined ? { mediaTypeAllowed: dto.mediaTypeAllowed } : {}),
          ...(dto.maxFilesAllowed !== undefined ? { maxFilesAllowed: dto.maxFilesAllowed } : {}),
          ...(dto.description !== undefined ? { description: dto.description } : {}),
        };
    }
  }

  async create(kind: ReferenceKind, dto: CreateReferenceDto) {
    const { model } = this.delegate(kind);
    // Code is required for every kind except subjects (keyed by name).
    if (kind !== 'subjects' && !dto.code?.trim()) {
      throw new BadRequestException('A code is required for this reference type.');
    }
    try {
      return await model.create({ data: this.shape(kind, dto) });
    } catch (e: any) {
      if (e?.code === 'P2002')
        throw new ConflictException('A row with this code or name already exists.');
      throw e;
    }
  }

  async update(kind: ReferenceKind, id: string, dto: UpdateReferenceDto) {
    const { model } = this.delegate(kind);
    const existing = await model.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Reference row not found.');
    try {
      return await model.update({ where: { id }, data: this.shape(kind, dto) });
    } catch (e: any) {
      if (e?.code === 'P2002')
        throw new ConflictException('A row with this code or name already exists.');
      throw e;
    }
  }
}
