import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from '../sessions/sessions.service';
import { SchoolsService, type RequestUser } from './schools.service';
import { CloudinaryService } from '../cloudinary/cloudinary.service';
import { CaptureStatus } from '../generated/prisma/client';
import { MediaUploadDto, MediaMetaDto } from './dto/media.dto';

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];

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
    const session = await this.sessions.findCurrent();
    const rows = session
      ? await this.prisma.schoolMedia.findMany({
          where: { schoolId, sessionId: session.id },
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'desc' }],
        })
      : [];
    const visit = session
      ? await this.prisma.schoolVisit.findUnique({
          where: { schoolId_sessionId: { schoolId, sessionId: session.id } },
        })
      : null;
    return {
      session,
      rows,
      status: visit?.mediaStatus ?? CaptureStatus.NOT_STARTED,
    };
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
    const session = await this.sessions.getCurrentOrThrow();
    await this.schools.ensureVisit(schoolId, session.id, user.id);

    const result = await this.cloudinary.uploadImage(
      file.buffer,
      `neuron/schools/${schoolId}`,
    );

    const makePrimary = dto.isPrimary === 'true';
    if (makePrimary) {
      await this.prisma.schoolMedia.updateMany({
        where: { schoolId, sessionId: session.id, isPrimary: true },
        data: { isPrimary: false },
      });
    }

    const row = await this.prisma.schoolMedia.create({
      data: {
        schoolId,
        sessionId: session.id,
        uploadedById: user.id,
        category: dto.category,
        caption: dto.caption,
        mediaType: 'image',
        publicId: result.public_id,
        fileUrl: result.secure_url,
        originalFileName: file.originalname ?? null,
        format: result.format ?? null,
        bytes: result.bytes ?? null,
        width: result.width ?? null,
        height: result.height ?? null,
        isPrimary: makePrimary,
      },
    });

    await this.bump(schoolId, session.id, user.id);
    return row;
  }

  async updateMeta(
    user: RequestUser,
    schoolId: string,
    mediaId: string,
    dto: MediaMetaDto,
  ) {
    await this.schools.requireScopedSchool(user, schoolId);
    const session = await this.sessions.getCurrentOrThrow();
    const existing = await this.owned(mediaId, schoolId, session.id);

    const makePrimary = dto.isPrimary === 'true';
    if (makePrimary && !existing.isPrimary) {
      await this.prisma.schoolMedia.updateMany({
        where: { schoolId, sessionId: session.id, isPrimary: true },
        data: { isPrimary: false },
      });
    }

    return this.prisma.schoolMedia.update({
      where: { id: mediaId },
      data: {
        category: dto.category,
        caption: dto.caption,
        isPrimary: dto.isPrimary === undefined ? existing.isPrimary : makePrimary,
      },
    });
  }

  async remove(user: RequestUser, schoolId: string, mediaId: string) {
    await this.schools.requireScopedSchool(user, schoolId);
    const session = await this.sessions.getCurrentOrThrow();
    const existing = await this.owned(mediaId, schoolId, session.id);

    await this.cloudinary.deleteImage(existing.publicId);
    await this.prisma.schoolMedia.delete({ where: { id: mediaId } });
    await this.bump(schoolId, session.id, user.id);
    return { message: 'Image removed.' };
  }

  async submit(user: RequestUser, schoolId: string) {
    await this.schools.requireScopedSchool(user, schoolId);
    const session = await this.sessions.getCurrentOrThrow();
    const count = await this.prisma.schoolMedia.count({
      where: { schoolId, sessionId: session.id },
    });
    if (count === 0) {
      throw new BadRequestException(
        'Upload at least one image before submitting.',
      );
    }
    const visit = await this.schools.ensureVisit(schoolId, session.id, user.id);
    await this.schools.setSectionStatus(
      visit.id,
      'mediaStatus',
      CaptureStatus.SUBMITTED,
    );
    return { message: 'Media capture submitted.' };
  }

  private async owned(mediaId: string, schoolId: string, sessionId: string) {
    const row = await this.prisma.schoolMedia.findUnique({
      where: { id: mediaId },
    });
    if (!row || row.schoolId !== schoolId || row.sessionId !== sessionId) {
      throw new NotFoundException('Image not found.');
    }
    return row;
  }

  private async bump(schoolId: string, sessionId: string, userId: string) {
    const count = await this.prisma.schoolMedia.count({
      where: { schoolId, sessionId },
    });
    const visit = await this.schools.ensureVisit(schoolId, sessionId, userId);
    await this.schools.setSectionStatus(
      visit.id,
      'mediaStatus',
      count > 0 ? CaptureStatus.DRAFT : CaptureStatus.NOT_STARTED,
    );
  }
}
