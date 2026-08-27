import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from '../sessions/sessions.service';
import {
  SchoolsService,
  sourceForUser,
  type RequestUser,
} from './schools.service';
import { CloudinaryService } from '../cloudinary/cloudinary.service';
import { CaptureStatus, CaptureSource } from '../generated/prisma/client';
import {
  MediaUploadDto,
  MediaMetaDto,
  SignUploadDto,
  ConfirmUploadDto,
  MarkCoverageDto,
} from './dto/media.dto';
import { randomUUID } from 'crypto';

// Upload ceilings, enforced when the signature is issued AND again against what
// actually landed on Cloudinary. Video is capped by duration as well as size:
// a field clip is meant to be a short walk-through, and duration is the limit an
// inspector can actually act on ("record a shorter clip").
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
export const MAX_VIDEO_SECONDS = 180;
// Browser-side chunk size for the direct upload. Small enough that a dropped
// connection on 3G costs one chunk, large enough to avoid per-request overhead.
export const UPLOAD_CHUNK_BYTES = 6 * 1024 * 1024;

const formatMb = (bytes: number) =>
  `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;

const ALLOWED_IMAGE_MIME = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
];
const ALLOWED_VIDEO_MIME = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/3gpp',
];

// Best-effort GPS extraction from a Cloudinary image_metadata result. EXIF stores
// GPS as strings/DMS; Cloudinary normalises common tags. Returns nulls if absent.
function extractExifGps(result: any): {
  lat: number | null;
  lng: number | null;
  takenAt: Date | null;
} {
  const meta = result?.image_metadata ?? {};
  const num = (v: unknown) => {
    const n = typeof v === 'string' ? parseFloat(v) : (v as number);
    return Number.isFinite(n) ? (n as number) : null;
  };
  let lat = num(meta.GPSLatitude ?? meta.GPSLatitudeDecimal);
  let lng = num(meta.GPSLongitude ?? meta.GPSLongitudeDecimal);
  if (lat != null && /S/i.test(String(meta.GPSLatitudeRef ?? ''))) lat = -lat;
  if (lng != null && /W/i.test(String(meta.GPSLongitudeRef ?? ''))) lng = -lng;
  const rawDate = meta.DateTimeOriginal ?? meta.DateTime;
  let takenAt: Date | null = null;
  if (typeof rawDate === 'string') {
    // EXIF "YYYY:MM:DD HH:MM:SS" → ISO.
    const iso = rawDate.replace(
      /^(\d{4}):(\d{2}):(\d{2})/,
      '$1-$2-$3',
    );
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) takenAt = d;
  }
  return { lat, lng, takenAt };
}

// The current capture period, carrying its session.
type Period = { id: string; sessionId: string };

@Injectable()
export class MediaService {
  constructor(
    private prisma: PrismaService,
    private sessions: SessionsService,
    private schools: SchoolsService,
    private cloudinary: CloudinaryService,
  ) {}

  async list(user: RequestUser, schoolId: string) {
    await this.schools.requireScopedSchool(user, schoolId);
    const period = await this.sessions.findCurrentPeriod();
    const source = sourceForUser(user);
    const rows = period
      ? await this.prisma.schoolMedia.findMany({
          where: { schoolId, periodId: period.id, source },
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'desc' }],
        })
      : [];
    const visit = period
      ? await this.prisma.schoolVisit.findUnique({
          where: {
            schoolId_periodId_source: { schoolId, periodId: period.id, source },
          },
        })
      : null;
    return {
      session: period ? { id: period.sessionId } : null,
      rows: rows.map((r) => this.withSignedUrl(r)),
      status: visit?.mediaStatus ?? CaptureStatus.NOT_STARTED,
      // Folded into the list rather than served from its own endpoint: the
      // checklist renders on the same screen as the photos, and a field
      // connection is the wrong place to spend a second round trip.
      subjects: await this.buildCoverage(schoolId, period?.id ?? null, source, rows),
    };
  }

  // ─── Shot-list coverage ─────────────────────────────────────────────────────
  //
  // The checklist: every active subject, how many photos it has, and whether it
  // has been marked absent. Counts come from the rows already fetched for the
  // gallery, so this costs one query for the list and one for the marks.
  private async buildCoverage(
    schoolId: string,
    periodId: string | null,
    source: CaptureSource,
    rows: { category: string }[],
  ) {
    // Started together, awaited separately: the ternary's empty branch would
    // otherwise widen the tuple and lose the row type inside Promise.all.
    const subjectsPromise = this.prisma.mediaCategory.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
    });
    const marksPromise = periodId
      ? this.prisma.mediaCoverage.findMany({
          where: { schoolId, periodId, source },
        })
      : null;
    const subjects = await subjectsPromise;
    const marks = marksPromise ? await marksPromise : [];

    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
    const markByCode = new Map(marks.map((m) => [m.categoryCode, m] as const));

    return subjects.map((c) => {
      const mark = markByCode.get(c.code);
      const count = counts.get(c.code) ?? 0;
      return {
        code: c.code,
        name: c.name,
        appliesToModule: c.appliesToModule,
        description: c.description,
        maxFilesAllowed: c.maxFilesAllowed,
        sortOrder: c.sortOrder,
        count,
        // A photo outranks an absence mark: if someone marked "no fire
        // extinguisher" and then photographed one, the photo is the truth.
        notPresent: count === 0 && !!mark,
        note: count === 0 ? (mark?.note ?? null) : null,
      };
    });
  }

  // Record that a subject genuinely isn't at this school. Refused once photos
  // exist for it — the two statements contradict each other, and the photo is
  // the stronger evidence.
  async markNotPresent(
    user: RequestUser,
    schoolId: string,
    dto: MarkCoverageDto,
  ) {
    await this.schools.requireScopedSchool(user, schoolId);
    const period = await this.sessions.getCurrentPeriodOrThrow();
    const source = sourceForUser(user);
    const category = await this.resolveCategory(dto.category);

    const existing = await this.prisma.schoolMedia.count({
      where: {
        schoolId,
        periodId: period.id,
        source,
        category: category.code,
        isActive: true,
      },
    });
    if (existing > 0) {
      throw new BadRequestException(
        `${category.name} already has ${existing} photo(s), so it can't be marked as not present. Delete them first if they were filed under the wrong subject.`,
      );
    }

    await this.prisma.mediaCoverage.upsert({
      where: {
        schoolId_periodId_source_categoryCode: {
          schoolId,
          periodId: period.id,
          source,
          categoryCode: category.code,
        },
      },
      create: {
        schoolId,
        sessionId: period.sessionId,
        periodId: period.id,
        source,
        categoryCode: category.code,
        status: 'NOT_PRESENT',
        note: dto.note ?? null,
        markedById: user.id,
      },
      update: { note: dto.note ?? null, markedById: user.id },
    });
    return this.list(user, schoolId);
  }

  // Undo the mark — the inspector looked again, or filed it against the wrong
  // subject.
  async clearNotPresent(user: RequestUser, schoolId: string, category: string) {
    await this.schools.requireScopedSchool(user, schoolId);
    const period = await this.sessions.getCurrentPeriodOrThrow();
    const source = sourceForUser(user);
    await this.prisma.mediaCoverage.deleteMany({
      where: {
        schoolId,
        periodId: period.id,
        source,
        categoryCode: category,
      },
    });
    return this.list(user, schoolId);
  }

  // Assets are private on Cloudinary; the delivery URL is signed on demand and
  // returned in `fileUrl`. Access control (requireScopedSchool) has already run
  // by the time we sign. `fileUrl` is never persisted as a public URL. Videos are
  // signed with the video resource type.
  private withSignedUrl<T extends { publicId: string; mediaType?: string }>(
    row: T,
  ): T {
    const kind = row.mediaType === 'video' ? 'video' : 'image';
    return { ...row, fileUrl: this.cloudinary.signedUrl(row.publicId, kind) };
  }

  // Resolves a shot-list subject by code, and refuses one that isn't on the
  // list. The old fixed Module A-D enum tolerated anything and stored it as a
  // bare string with a null FK; now that the Ministry maintains the list, an
  // unrecognised code means a stale client or a typo, and silently accepting it
  // would put photos in a bucket the checklist can never show.
  private async resolveCategory(code: string) {
    const row = await this.prisma.mediaCategory.findUnique({
      where: { code },
    });
    if (!row || !row.isActive) {
      throw new BadRequestException(
        `"${code}" is not on the photo list for this exercise.`,
      );
    }
    return row;
  }

  // Per-subject ceiling from the reference table. Checked before the bytes are
  // accepted, so an inspector isn't told their upload is refused only after
  // spending the data on it.
  private async assertRoomInCategory(
    schoolId: string,
    periodId: string,
    source: CaptureSource,
    category: { code: string; name: string; maxFilesAllowed: number | null },
    excludeMediaId?: string,
  ) {
    if (category.maxFilesAllowed == null) return;
    const count = await this.prisma.schoolMedia.count({
      where: {
        schoolId,
        periodId,
        source,
        category: category.code,
        isActive: true,
        ...(excludeMediaId ? { id: { not: excludeMediaId } } : {}),
      },
    });
    if (count >= category.maxFilesAllowed) {
      throw new BadRequestException(
        `${category.name} already has ${category.maxFilesAllowed} files, which is the limit for that subject. Delete one before adding another.`,
      );
    }
  }

  async upload(
    user: RequestUser,
    schoolId: string,
    file: Express.Multer.File | undefined,
    dto: MediaUploadDto,
  ) {
    if (!file) throw new BadRequestException('A file is required.');
    const isVideo = ALLOWED_VIDEO_MIME.includes(file.mimetype);
    const isImage = ALLOWED_IMAGE_MIME.includes(file.mimetype);
    if (!isImage && !isVideo) {
      throw new BadRequestException(
        'Only images (JPEG, PNG, WebP, HEIC) or video (MP4, WebM, MOV, 3GP) are accepted.',
      );
    }
    await this.schools.requireScopedSchool(user, schoolId);
    const period = await this.sessions.getCurrentPeriodOrThrow();
    const source = sourceForUser(user);
    await this.schools.ensureVisit(
      schoolId,
      period.id,
      period.sessionId,
      user.id,
      source,
    );

    // A queued offline upload can be replayed after its response was lost on a
    // flaky link. Check BEFORE sending the bytes: returning the existing row
    // here is what stops a duplicate asset (and a duplicate transfer over 3G).
    if (dto.clientId) {
      const already = await this.prisma.schoolMedia.findUnique({
        where: {
          schoolId_periodId_source_clientId: {
            schoolId,
            periodId: period.id,
            source,
            clientId: dto.clientId,
          },
        },
      });
      if (already) return this.withSignedUrl(already);
    }

    const folder = `neuron/schools/${schoolId}`;
    const result = isVideo
      ? await this.cloudinary.uploadVideo(file.buffer, folder)
      : await this.cloudinary.uploadImage(file.buffer, folder);

    // Best-effort GPS/timestamp from photo EXIF (Field Capture Guide §6).
    const exif = isVideo
      ? { lat: null, lng: null, takenAt: null }
      : extractExifGps(result);

    const makePrimary = dto.isPrimary === 'true';
    if (makePrimary) {
      await this.prisma.schoolMedia.updateMany({
        where: { schoolId, periodId: period.id, source, isPrimary: true },
        data: { isPrimary: false },
      });
    }

    const mediaCategory = await this.resolveCategory(dto.category);
    await this.assertRoomInCategory(schoolId, period.id, source, mediaCategory);

    let row;
    try {
      row = await this.prisma.schoolMedia.create({
        data: {
          schoolId,
          sessionId: period.sessionId,
          periodId: period.id,
          source,
          uploadedById: user.id,
          clientId: dto.clientId ?? null,
          category: dto.category,
          mediaCategoryId: mediaCategory.id,
          caption: dto.caption,
          mediaType: isVideo ? 'video' : 'image',
          publicId: result.public_id,
          // Never persist the delivery URL — private assets are signed on demand.
          fileUrl: '',
          originalFileName: file.originalname ?? null,
          format: result.format ?? null,
          bytes: result.bytes ?? null,
          width: result.width ?? null,
          height: result.height ?? null,
          videoDurationSecs:
            isVideo && typeof result.duration === 'number'
              ? Math.round(result.duration)
              : null,
          gpsLatitude: exif.lat,
          gpsLongitude: exif.lng,
          captureTimestamp: exif.takenAt,
          isPrimary: makePrimary,
        },
      });
    } catch (e: any) {
      // Two replays of the same queued upload can both clear the pre-check and
      // both push to Cloudinary. The loser deletes the asset it just created so
      // no orphan is left behind, then returns the row that won.
      if (e?.code === 'P2002' && dto.clientId) {
        await this.cloudinary
          .deleteImage(result.public_id, isVideo ? 'video' : 'image')
          .catch(() => undefined);
        const winner = await this.prisma.schoolMedia.findUnique({
          where: {
            schoolId_periodId_source_clientId: {
              schoolId,
              periodId: period.id,
              source,
              clientId: dto.clientId,
            },
          },
        });
        if (winner) return this.withSignedUrl(winner);
      }
      throw e;
    }

    await this.bump(schoolId, period, user.id, source);
    return this.withSignedUrl(row);
  }


  // ─── Direct upload: sign → (browser uploads) → confirm ─────────────────────

  /**
   * Authorise a browser-side upload. Runs the same scope and capture-period
   * checks as the proxied route, then hands back a signature the browser uses to
   * post the bytes straight to Cloudinary. Nothing is recorded yet.
   */
  async signUpload(user: RequestUser, schoolId: string, dto: SignUploadDto) {
    const resourceType = dto.mediaType === 'video' ? 'video' : 'image';
    await this.schools.requireScopedSchool(user, schoolId);
    const period = await this.sessions.getCurrentPeriodOrThrow();
    const source = sourceForUser(user);
    await this.schools.ensureVisit(
      schoolId,
      period.id,
      period.sessionId,
      user.id,
      source,
    );

    const limit = resourceType === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
    if (dto.bytes > limit) {
      throw new BadRequestException(
        resourceType === 'video'
          ? `Video is ${formatMb(dto.bytes)}. The limit is ${formatMb(limit)} — record a shorter clip (up to ${MAX_VIDEO_SECONDS / 60} minutes) and try again.`
          : `Photo is ${formatMb(dto.bytes)}. The limit is ${formatMb(limit)}.`,
      );
    }

    // The asset id is chosen by the server and covered by the signature, so a
    // client cannot redirect its upload into another school's folder — verified
    // against the live API: altering public_id returns 401 Invalid Signature.
    //
    // The folder is part of the id rather than a separate `folder` parameter;
    // Cloudinary prepends one to the other, which would nest the path twice.
    // (For image and video the stored id matches this exactly. Only `raw`
    // assets get a file extension appended, and we never upload those.)
    const folder = `neuron/schools/${schoolId}`;
    const publicId = `${folder}/${randomUUID()}`;

    const signed = this.cloudinary.signUploadParams({
      publicId,
      resourceType,
    });

    return {
      ...signed,
      publicId,
      resourceType,
      maxBytes: limit,
      // Chunk size for the browser's chunked upload, in bytes.
      chunkSize: UPLOAD_CHUNK_BYTES,
    };
  }

  /**
   * Record an asset the browser uploaded directly. Metadata is read back from
   * Cloudinary rather than taken from the request body — the client is not
   * trusted about what it uploaded, or about whether it uploaded anything.
   */
  async confirmUpload(user: RequestUser, schoolId: string, dto: ConfirmUploadDto) {
    const resourceType = dto.resourceType === 'video' ? 'video' : 'image';
    await this.schools.requireScopedSchool(user, schoolId);
    const period = await this.sessions.getCurrentPeriodOrThrow();
    const source = sourceForUser(user);

    // The asset must live in this school's folder. Without this check a caller
    // could confirm any public_id in the account, including another school's.
    if (!dto.publicId.startsWith(`neuron/schools/${schoolId}/`)) {
      throw new BadRequestException('That asset does not belong to this school.');
    }

    // Replay of a queued upload whose response was lost — return the existing row.
    if (dto.clientId) {
      const already = await this.prisma.schoolMedia.findUnique({
        where: {
          schoolId_periodId_source_clientId: {
            schoolId,
            periodId: period.id,
            source,
            clientId: dto.clientId,
          },
        },
      });
      if (already) {
        // The retry uploaded a second copy of the same file; drop it.
        if (already.publicId !== dto.publicId) {
          await this.cloudinary
            .deleteImage(dto.publicId, resourceType)
            .catch(() => undefined);
        }
        return this.withSignedUrl(already);
      }
    }

    const asset = await this.cloudinary.getResource(dto.publicId, resourceType);
    if (!asset) {
      throw new BadRequestException(
        "That upload didn't complete. Please try again.",
      );
    }

    const bytes = asset.bytes ?? 0;
    const limit = resourceType === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
    const duration =
      typeof asset.duration === 'number' ? Math.round(asset.duration) : null;

    // Enforce the caps against what actually landed, and clean up the asset if
    // it breaches them so nothing oversized lingers in the account.
    const tooBig = bytes > limit;
    const tooLong =
      resourceType === 'video' && duration !== null && duration > MAX_VIDEO_SECONDS;
    if (tooBig || tooLong) {
      await this.cloudinary
        .deleteImage(dto.publicId, resourceType)
        .catch(() => undefined);
      throw new BadRequestException(
        tooLong
          ? `That clip is ${duration}s. Videos must be ${MAX_VIDEO_SECONDS}s or shorter.`
          : `That file is ${formatMb(bytes)}, over the ${formatMb(limit)} limit.`,
      );
    }

    const exif =
      resourceType === 'video'
        ? { lat: null, lng: null, takenAt: null }
        : extractExifGps(asset);

    const makePrimary = dto.isPrimary === true;
    if (makePrimary) {
      await this.prisma.schoolMedia.updateMany({
        where: { schoolId, periodId: period.id, source, isPrimary: true },
        data: { isPrimary: false },
      });
    }

    const mediaCategory = await this.resolveCategory(dto.category);
    await this.assertRoomInCategory(schoolId, period.id, source, mediaCategory);

    let row;
    try {
      row = await this.prisma.schoolMedia.create({
        data: {
          schoolId,
          sessionId: period.sessionId,
          periodId: period.id,
          source,
          uploadedById: user.id,
          clientId: dto.clientId ?? null,
          category: dto.category,
          mediaCategoryId: mediaCategory.id,
          caption: dto.caption,
          mediaType: resourceType,
          publicId: dto.publicId,
          fileUrl: '',
          originalFileName: dto.originalFileName ?? null,
          format: asset.format ?? null,
          bytes,
          width: asset.width ?? null,
          height: asset.height ?? null,
          videoDurationSecs: duration,
          gpsLatitude: exif.lat,
          gpsLongitude: exif.lng,
          captureTimestamp: exif.takenAt,
          isPrimary: makePrimary,
        },
      });
    } catch (e: any) {
      if (e?.code === 'P2002' && dto.clientId) {
        await this.cloudinary
          .deleteImage(dto.publicId, resourceType)
          .catch(() => undefined);
        const winner = await this.prisma.schoolMedia.findUnique({
          where: {
            schoolId_periodId_source_clientId: {
              schoolId,
              periodId: period.id,
              source,
              clientId: dto.clientId,
            },
          },
        });
        if (winner) return this.withSignedUrl(winner);
      }
      throw e;
    }

    await this.bump(schoolId, period, user.id, source);
    return this.withSignedUrl(row);
  }

  async updateMeta(
    user: RequestUser,
    schoolId: string,
    mediaId: string,
    dto: MediaMetaDto,
  ) {
    await this.schools.requireScopedSchool(user, schoolId);
    const period = await this.sessions.getCurrentPeriodOrThrow();
    const source = sourceForUser(user);
    const existing = await this.owned(mediaId, schoolId, period.id, source);

    const makePrimary = dto.isPrimary === 'true';
    if (makePrimary && !existing.isPrimary) {
      await this.prisma.schoolMedia.updateMany({
        where: { schoolId, periodId: period.id, source, isPrimary: true },
        data: { isPrimary: false },
      });
    }

    const mediaCategory = await this.resolveCategory(dto.category);
    // Only when it's actually moving: re-saving a caption shouldn't fail just
    // because the subject it already sits in is full.
    if (dto.category !== existing.category) {
      await this.assertRoomInCategory(
        schoolId,
        period.id,
        source,
        mediaCategory,
        mediaId,
      );
    }
    const row = await this.prisma.schoolMedia.update({
      where: { id: mediaId },
      data: {
        category: dto.category,
        mediaCategoryId: mediaCategory.id,
        caption: dto.caption,
        isPrimary: dto.isPrimary === undefined ? existing.isPrimary : makePrimary,
      },
    });
    return this.withSignedUrl(row);
  }

  async remove(user: RequestUser, schoolId: string, mediaId: string) {
    await this.schools.requireScopedSchool(user, schoolId);
    const period = await this.sessions.getCurrentPeriodOrThrow();
    const source = sourceForUser(user);
    const existing = await this.owned(mediaId, schoolId, period.id, source);

    await this.cloudinary.deleteImage(
      existing.publicId,
      existing.mediaType === 'video' ? 'video' : 'image',
    );
    await this.prisma.schoolMedia.delete({ where: { id: mediaId } });
    await this.bump(schoolId, period, user.id, source);
    return { message: 'Image removed.' };
  }

  async submit(user: RequestUser, schoolId: string) {
    await this.schools.requireScopedSchool(user, schoolId);
    const period = await this.sessions.getCurrentPeriodOrThrow();
    const source = sourceForUser(user);
    const count = await this.prisma.schoolMedia.count({
      where: { schoolId, periodId: period.id, source },
    });
    if (count === 0) {
      throw new BadRequestException(
        'Upload at least one image before submitting.',
      );
    }
    const visit = await this.schools.ensureVisit(
      schoolId,
      period.id,
      period.sessionId,
      user.id,
      source,
    );
    await this.schools.setSectionStatus(
      visit.id,
      'mediaStatus',
      CaptureStatus.SUBMITTED,
    );
    return { message: 'Media capture submitted.' };
  }

  private async owned(
    mediaId: string,
    schoolId: string,
    periodId: string,
    source: CaptureSource,
  ) {
    const row = await this.prisma.schoolMedia.findUnique({
      where: { id: mediaId },
    });
    if (
      !row ||
      row.schoolId !== schoolId ||
      row.periodId !== periodId ||
      row.source !== source
    ) {
      throw new NotFoundException('Image not found.');
    }
    return row;
  }

  private async bump(
    schoolId: string,
    period: Period,
    userId: string,
    source: CaptureSource,
  ) {
    const count = await this.prisma.schoolMedia.count({
      where: { schoolId, periodId: period.id, source },
    });
    const visit = await this.schools.ensureVisit(
      schoolId,
      period.id,
      period.sessionId,
      userId,
      source,
    );
    await this.schools.setSectionStatus(
      visit.id,
      'mediaStatus',
      count > 0 ? CaptureStatus.DRAFT : CaptureStatus.NOT_STARTED,
    );
  }
}
