import { AdminSchoolsService } from './admin-schools.service';
import { ImportSchoolsDto } from './dto/admin-school.dto';

// The bulk import is the one place where a single bad cell used to cost the
// operator their whole upload, so its row-level behaviour is pinned down here.
// Prisma is stubbed: what matters is which rows are accepted, which are
// rejected and why, and that writes are batched rather than issued per row.

type UpsertCall = { where: { code: string }; create: any; update: any };

function makePrisma(existingCodes: string[] = [], lgas: any[] = []) {
  const upserts: UpsertCall[] = [];
  const transactions: number[] = [];
  return {
    upserts,
    transactions,
    school: {
      findMany: jest.fn(async ({ where }: any) =>
        (where.code.in as string[])
          .filter((c) => existingCodes.includes(c))
          .map((code) => ({ code })),
      ),
      upsert: jest.fn((args: UpsertCall) => {
        upserts.push(args);
        return args;
      }),
    },
    lga: {
      findMany: jest.fn(async () => lgas),
    },
    $transaction: jest.fn(async (ops: unknown[]) => {
      transactions.push(ops.length);
      return ops;
    }),
  };
}

const goodRow = (over: Record<string, unknown> = {}) => ({
  code: 'OY/001',
  name: 'Test Primary School',
  type: 'PRIMARY',
  ownership: 'PUBLIC',
  category: 'DAY',
  genderCategory: 'MIXED',
  lgaName: 'Ibadan North',
  ...over,
});

function service(prisma: any) {
  return new AdminSchoolsService(prisma as any);
}

describe('AdminSchoolsService.import', () => {
  it('imports valid rows and reports invalid ones by line number', async () => {
    const prisma = makePrisma();
    const dto: ImportSchoolsDto = {
      rows: [
        goodRow({ code: 'OY/001' }),
        goodRow({ code: 'OY/002', type: 'NURSERY' }), // not a valid school type
        goodRow({ code: 'OY/003' }),
        { code: 'OY/004' }, // missing every other required field
      ],
    };

    const res = await service(prisma).import(dto);

    expect(res.total).toBe(4);
    expect(res.created).toBe(2);
    expect(res.updated).toBe(0);
    expect(res.failed).toBe(2);

    // Line numbers are 1-based over the data rows, so they line up with what the
    // operator sees in their spreadsheet.
    expect(res.errors.map((e) => e.row)).toEqual([2, 4]);
    expect(res.errors[0].code).toBe('OY/002');
    expect(res.errors[0].messages.join(' ')).toContain('type');
    expect(res.errors[1].messages.join(' ')).toContain('name');

    // Only the two good rows were written.
    expect(prisma.upserts.map((u) => u.where.code)).toEqual([
      'OY/001',
      'OY/003',
    ]);
  });

  it('separates creates from updates using one lookup, not one per row', async () => {
    const prisma = makePrisma(['OY/002']);
    const res = await service(prisma).import({
      rows: [goodRow({ code: 'OY/001' }), goodRow({ code: 'OY/002' })],
    });

    expect(res.created).toBe(1);
    expect(res.updated).toBe(1);
    expect(prisma.school.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.lga.findMany).toHaveBeenCalledTimes(1);
  });

  it('rejects a code repeated inside the same file', async () => {
    const prisma = makePrisma();
    const res = await service(prisma).import({
      rows: [
        goodRow({ code: 'OY/001' }),
        goodRow({ code: 'OY/001', name: 'Duplicate' }),
      ],
    });

    expect(res.created).toBe(1);
    expect(res.failed).toBe(1);
    expect(res.errors[0].row).toBe(2);
    expect(res.errors[0].messages.join(' ')).toContain('duplicated');
    expect(prisma.upserts).toHaveLength(1);
  });

  it('validateOnly reports the outcome without writing anything', async () => {
    const prisma = makePrisma(['OY/002']);
    const res = await service(prisma).import({
      rows: [
        goodRow({ code: 'OY/001' }),
        goodRow({ code: 'OY/002' }),
        goodRow({ code: 'OY/003', ownership: 'STATE' }),
      ],
      validateOnly: true,
    });

    expect(res.validateOnly).toBe(true);
    expect(res.created).toBe(1);
    expect(res.updated).toBe(1);
    expect(res.failed).toBe(1);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.upserts).toHaveLength(0);
  });

  it('writes in chunked transactions rather than one round-trip per row', async () => {
    const prisma = makePrisma();
    const rows = Array.from({ length: 120 }, (_, i) =>
      goodRow({ code: `OY/${i}` }),
    );

    const res = await service(prisma).import({ rows });

    expect(res.created).toBe(120);
    expect(res.failed).toBe(0);
    // 120 rows at a chunk size of 50 → 3 transactions of 50/50/20.
    expect(prisma.transactions).toEqual([50, 50, 20]);
  });

  it('resolves the LGA reference once and applies it to every row', async () => {
    const prisma = makePrisma(
      [],
      [
        {
          id: 'lga-1',
          name: 'Ibadan North',
          zoneId: 'zone-1',
          zone: { name: 'Ibadan Zone' },
        },
      ],
    );

    await service(prisma).import({
      rows: [goodRow({ code: 'OY/001' }), goodRow({ code: 'OY/002' })],
    });

    expect(prisma.lga.findMany).toHaveBeenCalledTimes(1);
    for (const u of prisma.upserts) {
      expect(u.create.lgaId).toBe('lga-1');
      expect(u.create.zoneId).toBe('zone-1');
      expect(u.create.zoneName).toBe('Ibadan Zone');
    }
  });

  it('coerces numeric strings from the CSV and rejects out-of-range coordinates', async () => {
    const prisma = makePrisma();
    const res = await service(prisma).import({
      rows: [
        goodRow({ code: 'OY/001', latitude: '7.3775', longitude: '3.9470' }),
        goodRow({ code: 'OY/002', latitude: '99.9' }), // beyond +90
      ],
    });

    expect(res.created).toBe(1);
    expect(res.failed).toBe(1);
    expect(res.errors[0].messages.join(' ')).toContain('latitude');
    expect(prisma.upserts[0].create.latitude).toBeCloseTo(7.3775);
    expect(prisma.upserts[0].create.longitude).toBeCloseTo(3.947);
  });
});
