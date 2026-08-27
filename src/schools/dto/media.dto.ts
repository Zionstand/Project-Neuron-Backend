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

// Categories are no longer a fixed list here. They live in the MediaCategory
// reference table — one row per shot-list subject, carrying its own shooting
// instructions and file ceiling — so the Ministry can add or retire a subject
// without a redeploy. MediaService.resolveCategory is what rejects an unknown
// code; validating it here would freeze the list back into the build.

// Multipart fields accompanying the uploaded image. `isPrimary` arrives as a
// string ("true"/"false") from the form and is parsed in the service.
export class MediaUploadDto {
  @IsString() @IsNotEmpty() @MaxLength(60) category: string;

  @IsString() @IsNotEmpty() @MaxLength(500) caption: string;

  @IsOptional() @IsString() isPrimary?: string;

  // Idempotency key minted on the device when the photo was taken. A media
  // upload queued offline may be retried after the response was lost; without
  // this, the retry would store a second copy of the same file in Cloudinary.
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(64) clientId?: string;
}

// Editing an existing media row's metadata (no re-upload).
export class MediaMetaDto {
  @IsString() @IsNotEmpty() @MaxLength(60) category: string;

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

  @IsString() @IsNotEmpty() @MaxLength(60) category: string;

  @IsString() @IsNotEmpty() @MaxLength(500) caption: string;

  @IsOptional() @IsBoolean() isPrimary?: boolean;

  @IsOptional() @IsString() @MaxLength(255) originalFileName?: string;

  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(64) clientId?: string;
}

// ─── Shot-list coverage ───────────────────────────────────────────────────────

// Marking a subject absent. There is no "present" counterpart: a photo IS the
// presence mark, so the only thing that needs recording separately is a subject
// the school genuinely does not have.
export class MarkCoverageDto {
  @IsString() @IsNotEmpty() @MaxLength(60) category: string;

  // Why it isn't there, when that isn't obvious. Optional — forcing a sentence
  // would just produce "n/a" fifteen times.
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}
