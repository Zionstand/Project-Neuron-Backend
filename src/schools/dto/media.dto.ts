import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

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
