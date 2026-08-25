import { BadRequestException } from '@nestjs/common';
import {
  MediaService,
  MAX_VIDEO_BYTES,
  MAX_VIDEO_SECONDS,
} from './media.service';

// The direct-upload path moves the bytes outside our control, so the two things
// worth pinning down are: the client cannot point a confirm at an asset that
// isn't theirs, and the size/duration caps are enforced against what actually
// landed on Cloudinary rather than what the client claimed.

const SCHOOL = 'school-1';
const PERIOD = { id: 'period-1', sessionId: 'session-1' };
const USER = { id: 'user-1', sub: 'user-1', role: 'LIE' } as any;

function build(overrides: {
  resource?: any;
  existingByClientId?: any;
} = {}) {
  const deleted: string[] = [];
  const created: any[] = [];

  const prisma = {
    schoolMedia: {
      findUnique: jest.fn(async () => overrides.existingByClientId ?? null),
      updateMany: jest.fn(async () => ({ count: 0 })),
      create: jest.fn(async ({ data }: any) => {
        created.push(data);
        return { ...data, id: 'media-1' };
      }),
      count: jest.fn(async () => created.length),
    },
    mediaCategory: { findUnique: jest.fn(async () => ({ id: 'cat-1' })) },
  };

  const sessions = {
    getCurrentPeriodOrThrow: jest.fn(async () => PERIOD),
    findCurrentPeriod: jest.fn(async () => PERIOD),
  };

  const schools = {
    requireScopedSchool: jest.fn(async () => undefined),
    ensureVisit: jest.fn(async () => ({ id: 'visit-1' })),
    setSectionStatus: jest.fn(async () => undefined),
  };

  const cloudinary = {
    signUploadParams: jest.fn((p: any) => ({
      uploadUrl: 'https://api.cloudinary.com/v1_1/test/' + p.resourceType + '/upload',
      cloudName: 'test',
      apiKey: 'key',
      timestamp: 1,
      signature: 'sig',
      params: { folder: p.folder, public_id: p.publicId },
    })),
    getResource: jest.fn(async () => overrides.resource ?? null),
    deleteImage: jest.fn(async (id: string) => {
      deleted.push(id);
    }),
    signedUrl: jest.fn(() => 'https://signed.example/asset'),
  };

  const service = new MediaService(
    prisma as any,
    sessions as any,
    schools as any,
    cloudinary as any,
  );

  return { service, prisma, cloudinary, schools, deleted, created };
}

describe('MediaService.signUpload', () => {
  it('scopes the asset id to the school so a client cannot redirect it', async () => {
    const { service, cloudinary } = build();

    const res = await service.signUpload(USER, SCHOOL, {
      mediaType: 'video',
      bytes: 5_000_000,
    });

    expect(res.publicId.startsWith(`neuron/schools/${SCHOOL}/`)).toBe(true);
    expect(res.resourceType).toBe('video');
    expect(res.maxBytes).toBe(MAX_VIDEO_BYTES);
    // The public_id is part of the signed parameter set, so Cloudinary rejects
    // an upload that changes it.
    expect(cloudinary.signUploadParams).toHaveBeenCalledWith(
      expect.objectContaining({ publicId: res.publicId, resourceType: 'video' }),
    );
  });

  it('refuses an oversized file before any bytes are sent', async () => {
    const { service, schools } = build();

    await expect(
      service.signUpload(USER, SCHOOL, {
        mediaType: 'video',
        bytes: MAX_VIDEO_BYTES + 1,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    // Scope was still checked first — the refusal is not an auth bypass.
    expect(schools.requireScopedSchool).toHaveBeenCalled();
  });
});

describe('MediaService.confirmUpload', () => {
  const baseDto = {
    resourceType: 'video' as const,
    category: 'General',
    caption: 'Classroom block',
  };

  it("rejects an asset id outside the school's folder", async () => {
    const { service, prisma } = build({
      resource: { bytes: 1000, format: 'mp4', duration: 10 },
    });

    await expect(
      service.confirmUpload(USER, SCHOOL, {
        ...baseDto,
        publicId: 'neuron/schools/other-school/abc',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.schoolMedia.create).not.toHaveBeenCalled();
  });

  it('rejects a confirm for an asset that was never uploaded', async () => {
    const { service, prisma } = build({ resource: null });

    await expect(
      service.confirmUpload(USER, SCHOOL, {
        ...baseDto,
        publicId: `neuron/schools/${SCHOOL}/abc`,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.schoolMedia.create).not.toHaveBeenCalled();
  });

  it('trusts Cloudinary for the metadata, not the client', async () => {
    const { service, created } = build({
      resource: {
        bytes: 2_500_000,
        format: 'mp4',
        duration: 42.6,
        width: 1920,
        height: 1080,
      },
    });

    await service.confirmUpload(USER, SCHOOL, {
      ...baseDto,
      publicId: `neuron/schools/${SCHOOL}/abc`,
      originalFileName: 'clip.mp4',
    });

    expect(created[0]).toMatchObject({
      bytes: 2_500_000,
      format: 'mp4',
      width: 1920,
      height: 1080,
      videoDurationSecs: 43,
      mediaType: 'video',
      // The delivery URL is never persisted — private assets are signed on demand.
      fileUrl: '',
    });
  });

  it('deletes and refuses a clip that came in over the duration cap', async () => {
    const { service, deleted, prisma } = build({
      resource: { bytes: 1_000_000, duration: MAX_VIDEO_SECONDS + 30 },
    });

    await expect(
      service.confirmUpload(USER, SCHOOL, {
        ...baseDto,
        publicId: `neuron/schools/${SCHOOL}/abc`,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    // No orphaned asset left behind in the Cloudinary account.
    expect(deleted).toEqual([`neuron/schools/${SCHOOL}/abc`]);
    expect(prisma.schoolMedia.create).not.toHaveBeenCalled();
  });

  it('deletes and refuses a file that came in over the size cap', async () => {
    const { service, deleted } = build({
      resource: { bytes: MAX_VIDEO_BYTES + 1, duration: 10 },
    });

    await expect(
      service.confirmUpload(USER, SCHOOL, {
        ...baseDto,
        publicId: `neuron/schools/${SCHOOL}/abc`,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(deleted).toHaveLength(1);
  });

  it('returns the original row on a replayed offline upload and drops the duplicate asset', async () => {
    const existing = {
      id: 'media-1',
      publicId: `neuron/schools/${SCHOOL}/first`,
      mediaType: 'video',
    };
    const { service, prisma, deleted } = build({
      existingByClientId: existing,
      resource: { bytes: 1000, duration: 10 },
    });

    const row = await service.confirmUpload(USER, SCHOOL, {
      ...baseDto,
      publicId: `neuron/schools/${SCHOOL}/second`,
      clientId: 'job-1',
    });

    expect(row).toMatchObject({ id: 'media-1' });
    expect(prisma.schoolMedia.create).not.toHaveBeenCalled();
    // The retry's second copy is cleaned up rather than orphaned.
    expect(deleted).toEqual([`neuron/schools/${SCHOOL}/second`]);
  });
});
