import {
  Injectable,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  SchoolType,
  SchoolOwnership,
  SchoolCategory,
  GenderCategory,
  type Prisma,
} from '../generated/prisma/client';
import {
  CreateSchoolDto,
  UpdateSchoolDto,
  ImportSchoolsDto,
} from './dto/admin-school.dto';

@Injectable()
export class AdminSchoolsService {
  constructor(private prisma: PrismaService) {}

  // Registry list — unlike the LIE worklist this includes INACTIVE schools and
  // is not session/visit-joined.
  list(filters: { lga?: string; q?: string; active?: string; cluster?: string }) {
    const where: Prisma.SchoolWhereInput = {};
    if (filters.lga) where.lgaName = filters.lga;
    if (filters.cluster) where.cluster = filters.cluster;
    if (filters.active === 'true') where.isActive = true;
    if (filters.active === 'false') where.isActive = false;
    if (filters.q) {
      where.OR = [
        { name: { contains: filters.q, mode: 'insensitive' } },
        { code: { contains: filters.q, mode: 'insensitive' } },
        { community: { contains: filters.q, mode: 'insensitive' } },
      ];
    }
    return this.prisma.school.findMany({ where, orderBy: { name: 'asc' } });
  }

  async create(dto: CreateSchoolDto) {
    try {
      return await this.prisma.school.create({ data: this.toData(dto) });
    } catch (e: any) {
      if (e?.code === 'P2002')
        throw new ConflictException(
          `A school with code "${dto.code}" already exists.`,
        );
      throw e;
    }
  }

  async update(id: string, dto: UpdateSchoolDto) {
    await this.require(id);
    try {
      return await this.prisma.school.update({
        where: { id },
        data: this.toPartialData(dto),
      });
    } catch (e: any) {
      if (e?.code === 'P2002')
        throw new ConflictException(
          `A school with code "${dto.code}" already exists.`,
        );
      throw e;
    }
  }

  async setActive(id: string, isActive: boolean) {
    await this.require(id);
    return this.prisma.school.update({ where: { id }, data: { isActive } });
  }

  // Upsert each row by code. Validation already ran (ValidateNested), so we only
  // need to split created vs updated.
  async import(dto: ImportSchoolsDto) {
    let created = 0;
    let updated = 0;
    for (const row of dto.rows) {
      const existing = await this.prisma.school.findUnique({
        where: { code: row.code },
        select: { id: true },
      });
      if (existing) {
        await this.prisma.school.update({
          where: { code: row.code },
          data: this.toData(row),
        });
        updated++;
      } else {
        await this.prisma.school.create({ data: this.toData(row) });
        created++;
      }
    }
    return { created, updated, total: dto.rows.length };
  }

  private async require(id: string) {
    const s = await this.prisma.school.findUnique({ where: { id } });
    if (!s) throw new NotFoundException('School not found.');
    return s;
  }

  private toData(dto: CreateSchoolDto): Prisma.SchoolCreateInput {
    return {
      code: dto.code,
      name: dto.name,
      type: dto.type as SchoolType,
      ownership: dto.ownership as SchoolOwnership,
      category: dto.category as SchoolCategory,
      genderCategory: dto.genderCategory as GenderCategory,
      lgaName: dto.lgaName,
      lgaCode: dto.lgaCode ?? null,
      zoneName: dto.zoneName ?? null,
      cluster: dto.cluster ?? null,
      ward: dto.ward ?? null,
      community: dto.community ?? null,
      address: dto.address ?? null,
      latitude: dto.latitude ?? null,
      longitude: dto.longitude ?? null,
      isActive: dto.isActive ?? true,
    };
  }

  private toPartialData(dto: UpdateSchoolDto): Prisma.SchoolUpdateInput {
    const d: Prisma.SchoolUpdateInput = {};
    if (dto.code !== undefined) d.code = dto.code;
    if (dto.name !== undefined) d.name = dto.name;
    if (dto.type !== undefined) d.type = dto.type as SchoolType;
    if (dto.ownership !== undefined) d.ownership = dto.ownership as SchoolOwnership;
    if (dto.category !== undefined) d.category = dto.category as SchoolCategory;
    if (dto.genderCategory !== undefined)
      d.genderCategory = dto.genderCategory as GenderCategory;
    if (dto.lgaName !== undefined) d.lgaName = dto.lgaName;
    if (dto.lgaCode !== undefined) d.lgaCode = dto.lgaCode;
    if (dto.zoneName !== undefined) d.zoneName = dto.zoneName;
    if (dto.cluster !== undefined) d.cluster = dto.cluster;
    if (dto.ward !== undefined) d.ward = dto.ward;
    if (dto.community !== undefined) d.community = dto.community;
    if (dto.address !== undefined) d.address = dto.address;
    if (dto.latitude !== undefined) d.latitude = dto.latitude;
    if (dto.longitude !== undefined) d.longitude = dto.longitude;
    if (dto.isActive !== undefined) d.isActive = dto.isActive;
    return d;
  }
}
