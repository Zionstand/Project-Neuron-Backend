import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
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
  @IsOptional() @IsNumber() @Min(-90) @Max(90) latitude?: number;
  @IsOptional() @IsNumber() @Min(-180) @Max(180) longitude?: number;
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
  @IsOptional() @IsNumber() @Min(-90) @Max(90) latitude?: number;
  @IsOptional() @IsNumber() @Min(-180) @Max(180) longitude?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class SetActiveDto {
  @IsBoolean() isActive: boolean;
}

// Bulk import — upsert by code.
export class ImportSchoolsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2000)
  @ValidateNested({ each: true })
  @Type(() => CreateSchoolDto)
  rows: CreateSchoolDto[];
}
