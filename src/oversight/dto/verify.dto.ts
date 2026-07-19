import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export const SECTION_KEYS = [
  'asc',
  'students',
  'staff',
  'security',
  'media',
] as const;

export class SectionDto {
  @IsIn(SECTION_KEYS as unknown as string[]) section: string;
}

// Supervisor flag on a media file (Field Capture Guide §6). Empty reason = unflag.
export class FlagMediaDto {
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}
