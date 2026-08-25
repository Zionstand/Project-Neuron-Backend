import {
  Injectable,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { parsePage, paged } from '../common/pagination';
import {
  SchoolType,
  SchoolOwnership,
  SchoolCategory,
  GenderCategory,
  type Prisma,
} from '../generated/prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateSchoolDto,
  UpdateSchoolDto,
  ImportSchoolsDto,
  type ImportResult,
  type ImportRowError,
} from './dto/admin-school.dto';

// Rows are written in chunks so a 2,000-school spreadsheet doesn't open 2,000
// sequential round-trips to the database (which reliably outran the request
// timeout). Each chunk is one transaction: it either lands whole or not at all.
const IMPORT_CHUNK = 50;

@Injectable()
export class AdminSchoolsService {
  constructor(private prisma: PrismaService) {}

  // Registry list — unlike the LIE worklist this includes INACTIVE schools and
  // is not session/visit-joined.
  async list(filters: {
    lga?: string;
    q?: string;
    active?: string;
    cluster?: string;
    page?: string;
    pageSize?: string;
  }) {
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
    const params = parsePage(filters.page, filters.pageSize);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.school.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.school.count({ where }),
    ]);
    return paged(rows, total, params);
  }


  /**
   * One school, with everything the registry list can't show: its capture
   * history across periods, the principal bound to it, GPS provenance, and how
   * much data has actually been collected there. This is what an administrator
   * needs before editing or deactivating a record.
   */
  async getDetail(id: string) {
    const school = await this.prisma.school.findUnique({ where: { id } });
    if (!school) throw new NotFoundException('School not found.');

    const [principals, visits, mediaCount, studentCount, staffCount] =
      await Promise.all([
        // PRINCIPAL accounts bound to this school (normally one).
        this.prisma.user.findMany({
          where: { assignedSchoolId: id, isDeleted: false },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phoneNumber: true,
            role: true,
            accountStatus: true,
          },
        }),

        this.prisma.schoolVisit.findMany({
          where: { schoolId: id },
          orderBy: { updatedAt: 'desc' },
          take: 20,
          select: {
            id: true,
            source: true,
            overallStatus: true,
            ascStatus: true,
            studentsStatus: true,
            staffStatus: true,
            securityStatus: true,
            mediaStatus: true,
            updatedAt: true,
            session: { select: { id: true, name: true } },
            inspector: {
              select: { id: true, firstName: true, lastName: true, email: true },
            },
          },
        }),

        this.prisma.schoolMedia.count({ where: { schoolId: id } }),
        this.prisma.studentRecord.count({ where: { schoolId: id } }),
        this.prisma.staffRecord.count({ where: { schoolId: id } }),
      ]);

    return {
      school,
      principals,
      visits,
      stats: {
        visits: visits.length,
        media: mediaCount,
        studentRows: studentCount,
        staffRows: staffCount,
      },
    };
  }

  async create(dto: CreateSchoolDto) {
    try {
      return await this.prisma.school.create({ data: await this.toData(dto) });
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
        data: await this.toPartialData(dto),
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

  async setGpsVerified(id: string, gpsVerified: boolean) {
    await this.require(id);
    return this.prisma.school.update({ where: { id }, data: { gpsVerified } });
  }

  // Upsert each row by code. Validation already ran (ValidateNested), so we only
  // need to split created vs updated.
  /**
   * Bulk upsert by school code.
   *
   * Every row is validated independently: good rows import, bad rows come back
   * with their line number and the reason, so a single typo on line 417 no
   * longer costs the operator the whole upload. `validateOnly` runs the same
   * checks and writes nothing, which is what the UI's preview step calls.
   */
  async import(dto: ImportSchoolsDto): Promise<ImportResult> {
    const validateOnly = dto.validateOnly === true;
    const errors: ImportRowError[] = [];
    const valid: { row: number; dto: CreateSchoolDto }[] = [];

    // Duplicate codes inside one file would silently overwrite each other, so
    // the second and later occurrences are reported rather than applied.
    const seenCodes = new Map<string, number>();

    for (let i = 0; i < dto.rows.length; i++) {
      const rowNumber = i + 1;
      const raw = dto.rows[i] ?? {};
      const instance = plainToInstance(CreateSchoolDto, raw, {
        enableImplicitConversion: true,
      });
      const failures = await validate(instance, {
        whitelist: true,
        forbidNonWhitelisted: false,
      });

      if (failures.length) {
        errors.push({
          row: rowNumber,
          code: typeof raw.code === 'string' ? raw.code : null,
          messages: failures.flatMap((f) =>
            Object.values(f.constraints ?? {}).map(
              (m) => `${f.property}: ${m}`,
            ),
          ),
        });
        continue;
      }

      const firstSeen = seenCodes.get(instance.code);
      if (firstSeen !== undefined) {
        errors.push({
          row: rowNumber,
          code: instance.code,
          messages: [
            `code: duplicated in this file (first seen on line ${firstSeen})`,
          ],
        });
        continue;
      }
      seenCodes.set(instance.code, rowNumber);
      valid.push({ row: rowNumber, dto: instance });
    }

    const result: ImportResult = {
      total: dto.rows.length,
      created: 0,
      updated: 0,
      failed: errors.length,
      validateOnly,
      errors,
    };

    if (!valid.length) return result;

    // One lookup tells us create-vs-update for every row, instead of one query
    // each. Same for the LGA reference table, resolved once up front.
    const codes = valid.map((v) => v.dto.code);
    const existing = await this.prisma.school.findMany({
      where: { code: { in: codes } },
      select: { code: true },
    });
    const existingCodes = new Set(existing.map((e) => e.code));
    const lgaIndex = await this.lgaIndex();

    if (validateOnly) {
      for (const v of valid) {
        if (existingCodes.has(v.dto.code)) result.updated++;
        else result.created++;
      }
      return result;
    }

    for (let i = 0; i < valid.length; i += IMPORT_CHUNK) {
      const chunk = valid.slice(i, i + IMPORT_CHUNK);
      await this.prisma.$transaction(
        chunk.map((v) => {
          const data = this.toDataSync(v.dto, lgaIndex);
          return this.prisma.school.upsert({
            where: { code: v.dto.code },
            create: data,
            update: data,
          });
        }),
      );
      for (const v of chunk) {
        if (existingCodes.has(v.dto.code)) result.updated++;
        else result.created++;
      }
    }

    return result;
  }

  // LGA name → { lgaId, zoneId, zoneName }, loaded once per import.
  private async lgaIndex() {
    const lgas = await this.prisma.lga.findMany({ include: { zone: true } });
    return new Map(
      lgas.map((l) => [
        l.name,
        { lgaId: l.id, zoneId: l.zoneId, zoneName: l.zone?.name ?? null },
      ]),
    );
  }

  private async require(id: string) {
    const s = await this.prisma.school.findUnique({ where: { id } });
    if (!s) throw new NotFoundException('School not found.');
    return s;
  }

  // Resolve an LGA name to its normalized FK id + zone (id + name). Best-effort —
  // returns nulls if the LGA isn't in the reference table.
  private async resolveLga(lgaName?: string) {
    if (!lgaName) return { lgaId: null, zoneId: null, zoneName: null as string | null };
    const lga = await this.prisma.lga.findUnique({
      where: { name: lgaName },
      include: { zone: true },
    });
    return {
      lgaId: lga?.id ?? null,
      zoneId: lga?.zoneId ?? null,
      zoneName: lga?.zone?.name ?? null,
    };
  }

  // Same shape as toData, but reads the pre-loaded LGA index instead of hitting
  // the database per row. Used by the bulk import.
  private toDataSync(
    dto: CreateSchoolDto,
    lgaIndex: Map<
      string,
      { lgaId: string; zoneId: string | null; zoneName: string | null }
    >,
  ): Prisma.SchoolCreateInput {
    const geo = lgaIndex.get(dto.lgaName) ?? {
      lgaId: null as string | null,
      zoneId: null as string | null,
      zoneName: null as string | null,
    };
    return {
      code: dto.code,
      name: dto.name,
      type: dto.type as SchoolType,
      ownership: dto.ownership as SchoolOwnership,
      category: dto.category as SchoolCategory,
      genderCategory: dto.genderCategory as GenderCategory,
      lgaName: dto.lgaName,
      lgaCode: dto.lgaCode ?? null,
      zoneName: dto.zoneName ?? geo.zoneName,
      lgaId: geo.lgaId,
      zoneId: geo.zoneId,
      cluster: dto.cluster ?? null,
      ward: dto.ward ?? null,
      community: dto.community ?? null,
      address: dto.address ?? null,
      setting: dto.setting ?? null,
      latitude: dto.latitude ?? null,
      longitude: dto.longitude ?? null,
      dateEstablished: dto.dateEstablished ?? null,
      isActive: dto.isActive ?? true,
    };
  }

  private async toData(dto: CreateSchoolDto): Promise<Prisma.SchoolCreateInput> {
    const geo = await this.resolveLga(dto.lgaName);
    return {
      code: dto.code,
      name: dto.name,
      type: dto.type as SchoolType,
      ownership: dto.ownership as SchoolOwnership,
      category: dto.category as SchoolCategory,
      genderCategory: dto.genderCategory as GenderCategory,
      lgaName: dto.lgaName,
      lgaCode: dto.lgaCode ?? null,
      // Prefer an explicit zone; otherwise derive from the LGA reference row.
      zoneName: dto.zoneName ?? geo.zoneName,
      lgaId: geo.lgaId,
      zoneId: geo.zoneId,
      cluster: dto.cluster ?? null,
      ward: dto.ward ?? null,
      community: dto.community ?? null,
      address: dto.address ?? null,
      setting: dto.setting ?? null,
      latitude: dto.latitude ?? null,
      longitude: dto.longitude ?? null,
      dateEstablished: dto.dateEstablished ?? null,
      isActive: dto.isActive ?? true,
    };
  }

  private async toPartialData(
    dto: UpdateSchoolDto,
  ): Promise<Prisma.SchoolUpdateInput> {
    const d: Prisma.SchoolUpdateInput = {};
    if (dto.code !== undefined) d.code = dto.code;
    if (dto.name !== undefined) d.name = dto.name;
    if (dto.type !== undefined) d.type = dto.type as SchoolType;
    if (dto.ownership !== undefined) d.ownership = dto.ownership as SchoolOwnership;
    if (dto.category !== undefined) d.category = dto.category as SchoolCategory;
    if (dto.genderCategory !== undefined)
      d.genderCategory = dto.genderCategory as GenderCategory;
    if (dto.lgaName !== undefined) {
      d.lgaName = dto.lgaName;
      // Re-derive the normalized LGA/zone FKs whenever the LGA changes.
      const geo = await this.resolveLga(dto.lgaName);
      d.lgaId = geo.lgaId;
      d.zoneId = geo.zoneId;
      if (dto.zoneName === undefined) d.zoneName = geo.zoneName;
    }
    if (dto.lgaCode !== undefined) d.lgaCode = dto.lgaCode;
    if (dto.zoneName !== undefined) d.zoneName = dto.zoneName;
    if (dto.cluster !== undefined) d.cluster = dto.cluster;
    if (dto.ward !== undefined) d.ward = dto.ward;
    if (dto.community !== undefined) d.community = dto.community;
    if (dto.setting !== undefined) d.setting = dto.setting;
    if (dto.address !== undefined) d.address = dto.address;
    if (dto.latitude !== undefined) d.latitude = dto.latitude;
    if (dto.longitude !== undefined) d.longitude = dto.longitude;
    if (dto.dateEstablished !== undefined) d.dateEstablished = dto.dateEstablished;
    if (dto.isActive !== undefined) d.isActive = dto.isActive;
    return d;
  }
}
