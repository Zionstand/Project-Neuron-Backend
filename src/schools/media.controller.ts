import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/roles.guard';
import { Roles } from '../common/roles.decorator';
import { CaptureScopeGuard } from '../common/capture-scope.guard';
import { CaptureSection } from '../common/capture-scope.decorator';
import {
  CAN_READ_SCHOOL_REGISTRY,
  CAN_SUBMIT_INSPECTION,
} from '../common/roles.constants';
import { MediaService, MAX_IMAGE_BYTES } from './media.service';
import {
  MediaUploadDto,
  MediaMetaDto,
  SignUploadDto,
  ConfirmUploadDto,
} from './dto/media.dto';

// Photos only, and small ones. Anything larger — and all video — goes through
// the signed direct-to-Cloudinary route instead: buffering a 100 MB clip in this
// process and then re-uploading it to Cloudinary held the request open for both
// transfers and reliably outran the host request timeout.
const mediaUpload = FileInterceptor('file', {
  limits: { fileSize: MAX_IMAGE_BYTES },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) return cb(null, true);
    if (file.mimetype.startsWith('video/')) {
      return cb(
        new BadRequestException(
          'Video must use the direct upload route (POST media/signature).',
        ),
        false,
      );
    }
    cb(
      new BadRequestException('Only image or video files are accepted.'),
      false,
    );
  },
});

// Tagged at class level — every route here belongs to the media section, so the
// whole controller goes quiet when that section is out of scope.
@UseGuards(JwtAuthGuard, RolesGuard, CaptureScopeGuard)
@CaptureSection('media')
@Controller('schools/:id/media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Roles(...CAN_READ_SCHOOL_REGISTRY)
  @Get()
  list(@Req() req: any, @Param('id') id: string) {
    return this.media.list(req.user, id);
  }

  @Roles(...CAN_SUBMIT_INSPECTION)
  @Post()
  @UseInterceptors(mediaUpload)
  upload(
    @Req() req: any,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: MediaUploadDto,
  ) {
    return this.media.upload(req.user, id, file, dto);
  }

  // Direct upload, step 1: authorise a browser-side upload to Cloudinary. Large
  // files (all video) never pass through this server — see MediaService.signUpload.
  @Roles(...CAN_SUBMIT_INSPECTION)
  @Post('signature')
  signUpload(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: SignUploadDto,
  ) {
    return this.media.signUpload(req.user, id, dto);
  }

  // Direct upload, step 2: the bytes are on Cloudinary; record the asset.
  @Roles(...CAN_SUBMIT_INSPECTION)
  @Post('confirm')
  confirmUpload(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: ConfirmUploadDto,
  ) {
    return this.media.confirmUpload(req.user, id, dto);
  }

  @Roles(...CAN_SUBMIT_INSPECTION)
  @Post('submit')
  submit(@Req() req: any, @Param('id') id: string) {
    return this.media.submit(req.user, id);
  }

  @Roles(...CAN_SUBMIT_INSPECTION)
  @Put(':mediaId')
  updateMeta(
    @Req() req: any,
    @Param('id') id: string,
    @Param('mediaId') mediaId: string,
    @Body() dto: MediaMetaDto,
  ) {
    return this.media.updateMeta(req.user, id, mediaId, dto);
  }

  @Roles(...CAN_SUBMIT_INSPECTION)
  @Delete(':mediaId')
  remove(
    @Req() req: any,
    @Param('id') id: string,
    @Param('mediaId') mediaId: string,
  ) {
    return this.media.remove(req.user, id, mediaId);
  }
}
