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
import {
  CAN_READ_SCHOOL_REGISTRY,
  CAN_SUBMIT_INSPECTION,
} from '../common/roles.constants';
import { MediaService } from './media.service';
import { MediaUploadDto, MediaMetaDto } from './dto/media.dto';

// Images only (no video). Reject non-images early and cap size at 10 MB.
const imageUpload = FileInterceptor('file', {
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) return cb(null, true);
    cb(
      new BadRequestException('Only image files are accepted (no video).'),
      false,
    );
  },
});

@UseGuards(JwtAuthGuard, RolesGuard)
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
  @UseInterceptors(imageUpload)
  upload(
    @Req() req: any,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: MediaUploadDto,
  ) {
    return this.media.upload(req.user, id, file, dto);
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
