import { Injectable, Logger } from '@nestjs/common';
import {
  v2 as cloudinary,
  type UploadApiResponse,
} from 'cloudinary';

// School condition media is Ministry data and must never be publicly reachable.
// Assets are uploaded as `authenticated` (no permanent public URL exists) and
// delivered only via short-lived signed URLs generated at request time — the DB
// stores the public_id, never a delivery URL.
const SIGNED_URL_TTL_SECONDS = 15 * 60;

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

  // Upload an image buffer as a private (authenticated) asset. The returned
  // secure_url requires a signature to load and is deliberately NOT persisted;
  // we keep public_id only and sign on demand. `image_metadata` asks Cloudinary
  // to parse EXIF so we can best-effort extract GPS later.
  uploadImage(buffer: Buffer, folder: string): Promise<UploadApiResponse> {
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder,
          resource_type: 'image',
          type: 'authenticated',
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

  // Upload a video buffer as a private (authenticated) asset. Cloudinary returns
  // `duration` (seconds) which we persist. Signed the same way as images.
  uploadVideo(buffer: Buffer, folder: string): Promise<UploadApiResponse> {
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder,
          resource_type: 'video',
          type: 'authenticated',
        },
        (error, result) => {
          if (error || !result) {
            this.logger.error(`Cloudinary video upload failed: ${error?.message}`);
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

  // Generate a signed delivery URL for a private asset. When token auth is
  // enabled on the account (CLOUDINARY_AUTH_KEY set) the URL expires after
  // SIGNED_URL_TTL_SECONDS, per the briefing; otherwise it falls back to a
  // tamper-proof (non-expiring) signed URL. Callers MUST enforce access
  // control before calling this — signing does not check ownership.
  signedUrl(publicId: string, resourceType: 'image' | 'video' = 'image'): string {
    const authKey = process.env.CLOUDINARY_AUTH_KEY;
    const opts: Record<string, unknown> = {
      resource_type: resourceType,
      type: 'authenticated',
      secure: true,
    };
    if (authKey) {
      opts.auth_token = { key: authKey, duration: SIGNED_URL_TTL_SECONDS };
    } else {
      opts.sign_url = true;
    }
    return cloudinary.url(publicId, opts as never);
  }

  async deleteImage(
    publicId: string,
    resourceType: 'image' | 'video' = 'image',
  ): Promise<void> {
    try {
      await cloudinary.uploader.destroy(publicId, {
        resource_type: resourceType,
        type: 'authenticated',
      });
    } catch (e) {
      // Don't block the DB delete if the asset is already gone.
      this.logger.warn(
        `Cloudinary delete failed for ${publicId}: ${(e as Error).message}`,
      );
    }
  }
}
