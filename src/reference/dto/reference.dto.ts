import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

// The dimension being managed. Read routes are per-kind; admin CRUD is generic.
export const REFERENCE_KINDS = [
  'zones',
  'lgas',
  'class-levels',
  'qualifications',
  'subjects',
  'media-categories',
] as const;
export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

// A superset of fields across all dims; the service validates per-kind.
export class CreateReferenceDto {
  @IsOptional() @IsString() @MaxLength(40) code?: string;
  @IsString() @IsNotEmpty() @MaxLength(200) name: string;
  @IsOptional() @IsString() @MaxLength(120) zoneId?: string; // lgas
  @IsOptional() @IsString() @MaxLength(120) educationLevel?: string; // class-levels
  @IsOptional() @IsInt() @Min(0) sortOrder?: number; // class-levels
  @IsOptional() @IsInt() @Min(0) rank?: number; // qualifications
  @IsOptional() @IsString() @MaxLength(120) category?: string; // subjects
  @IsOptional() @IsString() @MaxLength(40) appliesToModule?: string; // media-categories
  @IsOptional() @IsString() @MaxLength(20) mediaTypeAllowed?: string; // media-categories
  @IsOptional() @IsInt() @Min(0) maxFilesAllowed?: number; // media-categories
  @IsOptional() @IsString() @MaxLength(500) description?: string; // media-categories
}

export class UpdateReferenceDto extends CreateReferenceDto {
  @IsOptional() @IsString() @MaxLength(200) declare name: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}
