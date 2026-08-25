import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

// MediaCategory_ID options (Field Capture Guide §1.8 / §6).
export const MEDIA_CATEGORIES = [
  'Module A',
  'Module B',
  'Module C',
  'Module D',
  'General',
] as const;

const inList = (arr: readonly string[]) => arr as unknown as string[];

// Multipart fields accompanying the uploaded image. `isPrimary` arrives as a
// string ("true"/"false") from the form and is parsed in the service.
export class MediaUploadDto {
  @IsIn(inList(MEDIA_CATEGORIES)) category: string;

  @IsString() @IsNotEmpty() @MaxLength(500) caption: string;

  @IsOptional() @IsString() isPrimary?: string;

  // Idempotency key minted on the device when the photo was taken. A media
  // upload queued offline may be retried after the response was lost; without
  // this, the retry would store a second copy of the same file in Cloudinary.
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(64) clientId?: string;
}

// Editing an existing media row's metadata (no re-upload).
export class MediaMetaDto {
  @IsIn(inList(MEDIA_CATEGORIES)) category: string;

  @IsString() @IsNotEmpty() @MaxLength(500) caption: string;

  @IsOptional() @IsString() isPrimary?: string;
}

// ─── Direct-to-Cloudinary upload ──────────────────────────────────────────────

// Step 1: ask the server to authorise an upload the browser will perform itself.
export class SignUploadDto {
  @IsIn(['image', 'video']) mediaType: 'image' | 'video';

  // Declared size, checked up front so an oversized file is refused before the
  // inspector spends their data allowance on it. Re-checked after the fact
  // against what Cloudinary actually received.
  @IsInt() @Min(1) bytes: number;
}

// Step 2: the bytes are on Cloudinary; record the asset. Everything about the
// file itself (size, format, dimensions, duration, EXIF) is read back from
// Cloudinary — only the operator's own metadata is taken from this body.
export class ConfirmUploadDto {
  @IsString() @IsNotEmpty() @MaxLength(300) publicId: string;

  @IsIn(['image', 'video']) resourceType: 'image' | 'video';

  @IsIn(inList(MEDIA_CATEGORIES)) category: string;

  @IsString() @IsNotEmpty() @MaxLength(500) caption: string;

  @IsOptional() @IsBoolean() isPrimary?: boolean;

  @IsOptional() @IsString() @MaxLength(255) originalFileName?: string;

  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(64) clientId?: string;
}
