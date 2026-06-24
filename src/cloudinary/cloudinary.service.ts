import { Injectable, Logger } from '@nestjs/common';
import {
  v2 as cloudinary,
  type UploadApiResponse,
} from 'cloudinary';

@Injectable()
export class CloudinaryService {
  private readonly logger = new Logger(CloudinaryService.name);

  constructor() {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure: true,
    });
  }

  // Upload an image buffer. Returns Cloudinary's metadata (secure_url, public_id,
  // dimensions, format, bytes). `image_metadata` asks Cloudinary to parse EXIF so
  // we can best-effort extract GPS.
  uploadImage(buffer: Buffer, folder: string): Promise<UploadApiResponse> {
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder,
          resource_type: 'image',
          image_metadata: true,
        },
        (error, result) => {
          if (error || !result) {
            this.logger.error(`Cloudinary upload failed: ${error?.message}`);
            return reject(
              error ?? new Error('Cloudinary returned no result.'),
            );
          }
          resolve(result);
        },
      );
      stream.end(buffer);
    });
  }

  async deleteImage(publicId: string): Promise<void> {
    try {
      await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
    } catch (e) {
      // Don't block the DB delete if the asset is already gone.
      this.logger.warn(
        `Cloudinary delete failed for ${publicId}: ${(e as Error).message}`,
      );
    }
  }
}
