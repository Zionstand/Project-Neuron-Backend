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
import { MediaUploadDto, MediaMetaDto } from './dto/media.dto';

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];

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
    };
  }

  // Assets are private on Cloudinary; the delivery URL is signed on demand and
  // returned in `fileUrl`. Access control (requireScopedSchool) has already run
  // by the time we sign. `fileUrl` is never persisted as a public URL.
  private withSignedUrl<T extends { publicId: string }>(row: T): T {
    return { ...row, fileUrl: this.cloudinary.signedUrl(row.publicId) };
  }

  async upload(
    user: RequestUser,
    schoolId: string,
    file: Express.Multer.File | undefined,
    dto: MediaUploadDto,
  ) {
    if (!file) throw new BadRequestException('An image file is required.');
    if (!ALLOWED_MIME.includes(file.mimetype)) {
      throw new BadRequestException(
        'Only image files (JPEG, PNG, WebP, HEIC) are accepted.',
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

    const result = await this.cloudinary.uploadImage(
      file.buffer,
      `neuron/schools/${schoolId}`,
    );

    const makePrimary = dto.isPrimary === 'true';
    if (makePrimary) {
      await this.prisma.schoolMedia.updateMany({
        where: { schoolId, periodId: period.id, source, isPrimary: true },
        data: { isPrimary: false },
      });
    }

    const row = await this.prisma.schoolMedia.create({
      data: {
        schoolId,
        sessionId: period.sessionId,
        periodId: period.id,
        source,
        uploadedById: user.id,
        category: dto.category,
        caption: dto.caption,
        mediaType: 'image',
        publicId: result.public_id,
        // Never persist the delivery URL — private assets are signed on demand.
        fileUrl: '',
        originalFileName: file.originalname ?? null,
        format: result.format ?? null,
        bytes: result.bytes ?? null,
        width: result.width ?? null,
        height: result.height ?? null,
        isPrimary: makePrimary,
      },
    });

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

    const row = await this.prisma.schoolMedia.update({
      where: { id: mediaId },
      data: {
        category: dto.category,
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

    await this.cloudinary.deleteImage(existing.publicId);
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
