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
}

// Editing an existing media row's metadata (no re-upload).
export class MediaMetaDto {
  @IsIn(inList(MEDIA_CATEGORIES)) category: string;

  @IsString() @IsNotEmpty() @MaxLength(500) caption: string;

  @IsOptional() @IsString() isPrimary?: string;
}
