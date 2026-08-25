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

  // ─── Signed direct (browser → Cloudinary) upload ───────────────────────────
  //
  // Routing bytes through the API server meant a field clip was uploaded twice:
  // once over the inspector's 3G link into the server's memory, then again from
  // the server to Cloudinary — with the original HTTP request held open for the
  // whole of both. Anything sizeable outran the host's request timeout.
  //
  // Instead the server signs a short-lived upload request and the browser posts
  // the bytes straight to Cloudinary (chunked, so a dropped connection costs one
  // chunk rather than the whole file). The server never sees the file; it
  // verifies the resulting asset through the Admin API before recording it.

  /**
   * Sign an upload the browser will perform on its own. The signature covers the
   * exact parameters returned here — Cloudinary rejects the upload if the client
   * alters any of them, so the folder and asset id cannot be tampered with.
   */
  signUploadParams(params: {
    publicId: string;
    resourceType: 'image' | 'video';
  }): {
    uploadUrl: string;
    cloudName: string;
    apiKey: string;
    timestamp: number;
    signature: string;
    params: Record<string, string>;
  } {
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME ?? '';
    const apiKey = process.env.CLOUDINARY_API_KEY ?? '';
    const apiSecret = process.env.CLOUDINARY_API_SECRET ?? '';
    const timestamp = Math.round(Date.now() / 1000);

    // Signed set. `type: authenticated` keeps the asset private, exactly as the
    // server-side upload did — there is no publicly reachable URL for it.
    //
    // NOTE: no `folder` param. Cloudinary PREPENDS folder to public_id, so
    // sending both a folder and a folder-qualified public_id stores the asset at
    // "neuron/schools/X/neuron/schools/X/<id>" — and the confirm step, looking up
    // the id we handed the client, would never find it. The full path lives in
    // public_id alone, which the signature still covers.
    const toSign: Record<string, string> = {
      public_id: params.publicId,
      timestamp: String(timestamp),
      type: 'authenticated',
    };
    // EXIF (and therefore GPS) only comes back for images.
    if (params.resourceType === 'image') toSign.image_metadata = 'true';

    const signature = cloudinary.utils.api_sign_request(toSign, apiSecret);

    return {
      uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/${params.resourceType}/upload`,
      cloudName,
      apiKey,
      timestamp,
      signature,
      params: toSign,
    };
  }

  /**
   * Read an asset's real metadata from Cloudinary. The confirm step uses this
   * instead of trusting the numbers the browser reports: the client could claim
   * any size, duration or public_id it liked.
   */
  async getResource(
    publicId: string,
    resourceType: 'image' | 'video' = 'image',
  ): Promise<UploadApiResponse | null> {
    try {
      const res = await cloudinary.api.resource(publicId, {
        resource_type: resourceType,
        type: 'authenticated',
        image_metadata: resourceType === 'image',
      });
      return res as unknown as UploadApiResponse;
    } catch (e) {
      this.logger.warn(
        `Cloudinary resource lookup failed for ${publicId}: ${(e as Error).message}`,
      );
      return null;
    }
  }
}
