import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  Max,
  ValidateNested,
} from 'class-validator';

export const SCHOOL_TYPES = [
  'PRIMARY',
  'JSS',
  'SSS',
  'COMBINED_PRY_JSS',
  'COMBINED_JSS_SSS',
  'COMBINED_PRY_SSS',
] as const;
export const OWNERSHIPS = ['PUBLIC', 'MISSION', 'PRIVATE'] as const;
export const CATEGORIES = ['DAY', 'BOARDING', 'SEMI_BOARDING'] as const;
export const GENDER_CATEGORIES = ['MIXED', 'BOYS_ONLY', 'GIRLS_ONLY'] as const;
// Rural / urban siting, as recorded in the Ministry's school register.
export const SCHOOL_SETTINGS = ['Rural', 'Urban / Peri-urban'] as const;

const inList = (arr: readonly string[]) => arr as unknown as string[];

export class CreateSchoolDto {
  @IsString() @IsNotEmpty() @MaxLength(40) code: string;
  @IsString() @IsNotEmpty() @MaxLength(200) name: string;
  @IsIn(inList(SCHOOL_TYPES)) type: string;
  @IsIn(inList(OWNERSHIPS)) ownership: string;
  @IsIn(inList(CATEGORIES)) category: string;
  @IsIn(inList(GENDER_CATEGORIES)) genderCategory: string;
  @IsString() @IsNotEmpty() @MaxLength(120) lgaName: string;
  @IsOptional() @IsString() @MaxLength(40) lgaCode?: string;
  @IsOptional() @IsString() @MaxLength(120) zoneName?: string;
  @IsOptional() @IsString() @MaxLength(120) cluster?: string;
  @IsOptional() @IsString() @MaxLength(120) ward?: string;
  @IsOptional() @IsString() @MaxLength(120) community?: string;
  @IsOptional() @IsString() @MaxLength(300) address?: string;
  @IsOptional() @IsIn(inList(SCHOOL_SETTINGS)) setting?: string;
  @IsOptional() @IsNumber() @Min(-90) @Max(90) latitude?: number;
  @IsOptional() @IsNumber() @Min(-180) @Max(180) longitude?: number;
  @IsOptional() @IsInt() @Min(1800) @Max(2100) dateEstablished?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

// All fields optional for partial edits.
export class UpdateSchoolDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(40) code?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(200) name?: string;
  @IsOptional() @IsIn(inList(SCHOOL_TYPES)) type?: string;
  @IsOptional() @IsIn(inList(OWNERSHIPS)) ownership?: string;
  @IsOptional() @IsIn(inList(CATEGORIES)) category?: string;
  @IsOptional() @IsIn(inList(GENDER_CATEGORIES)) genderCategory?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(120) lgaName?: string;
  @IsOptional() @IsString() @MaxLength(40) lgaCode?: string;
  @IsOptional() @IsString() @MaxLength(120) zoneName?: string;
  @IsOptional() @IsString() @MaxLength(120) cluster?: string;
  @IsOptional() @IsString() @MaxLength(120) ward?: string;
  @IsOptional() @IsString() @MaxLength(120) community?: string;
  @IsOptional() @IsString() @MaxLength(300) address?: string;
  @IsOptional() @IsIn(inList(SCHOOL_SETTINGS)) setting?: string;
  @IsOptional() @IsNumber() @Min(-90) @Max(90) latitude?: number;
  @IsOptional() @IsNumber() @Min(-180) @Max(180) longitude?: number;
  @IsOptional() @IsInt() @Min(1800) @Max(2100) dateEstablished?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class SetActiveDto {
  @IsBoolean() isActive: boolean;
}

export class GpsVerifyDto {
  @IsBoolean() gpsVerified: boolean;
}

// Bulk import — upsert by code.
//
// Rows are deliberately NOT validated by the pipe with @ValidateNested: a single
// malformed row in a 2,000-row spreadsheet would reject the entire file with an
// unreadable wall of "rows.417.type must be one of…" messages. The service
// validates each row on its own instead, imports the good ones and reports the
// bad ones by line number.
export class ImportSchoolsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5000)
  rows: Record<string, unknown>[];

  // Dry run: validate and report, write nothing. Powers the preview step.
  @IsOptional() @IsBoolean() validateOnly?: boolean;
}

export interface ImportRowError {
  // 1-based position in the uploaded file's data rows, for "line 417" messaging.
  row: number;
  code: string | null;
  messages: string[];
}

export interface ImportResult {
  total: number;
  created: number;
  updated: number;
  failed: number;
  validateOnly: boolean;
  errors: ImportRowError[];
}
