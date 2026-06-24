import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

// ─── Option sets (Field Capture Guide §§2–4) ──────────────────────────────────
export const GENDERS = ['MALE', 'FEMALE'] as const;
export const CLASS_LEVELS = [
  'Pry1',
  'Pry2',
  'Pry3',
  'Pry4',
  'Pry5',
  'Pry6',
  'JSS1',
  'JSS2',
  'JSS3',
  'SSS1',
  'SSS2',
  'SSS3',
] as const;
export const ENROLMENT_TYPES = [
  'New',
  'Continuing',
  'Returning',
  'Transfer-In',
] as const;
export const TRANSPORT_MODES = [
  'Walking',
  'Bicycle',
  'Motorcycle',
  'Vehicle',
  'Public Transport',
] as const;
export const EXIT_REASONS = [
  'Dropout',
  'Transfer-Out',
  'Completed',
  'Deceased',
  'Unknown',
] as const;
export const STAFF_TYPES = ['Teaching', 'Non-Teaching'] as const;
export const EMPLOYMENT_TYPES = [
  'Permanent',
  'Contract',
  'NYSC',
  'Volunteer',
] as const;
export const QUALIFICATIONS = [
  'NCE',
  'OND',
  'HND',
  'BSc',
  'BEd',
  'PGDE',
  'MSc',
  'MEd',
  'PhD',
  'Other',
] as const;
export const NIGERIAN_STATES = [
  'Abia',
  'Adamawa',
  'Akwa Ibom',
  'Anambra',
  'Bauchi',
  'Bayelsa',
  'Benue',
  'Borno',
  'Cross River',
  'Delta',
  'Ebonyi',
  'Edo',
  'Ekiti',
  'Enugu',
  'FCT',
  'Gombe',
  'Imo',
  'Jigawa',
  'Kaduna',
  'Kano',
  'Katsina',
  'Kebbi',
  'Kogi',
  'Kwara',
  'Lagos',
  'Nasarawa',
  'Niger',
  'Ogun',
  'Ondo',
  'Osun',
  'Oyo',
  'Plateau',
  'Rivers',
  'Sokoto',
  'Taraba',
  'Yobe',
  'Zamfara',
] as const;

const inList = (arr: readonly string[]) => arr as unknown as string[];

// ─── Annual School Census ─────────────────────────────────────────────────────
export class AscRecordDto {
  @IsIn(inList(CLASS_LEVELS)) classLevel: string;
  @IsIn(inList(GENDERS)) gender: string;

  @IsInt() @Min(0) @Max(100000) enrolmentCount: number;
  @IsInt() @Min(0) @Max(100000) newEntrants: number;
  @IsInt() @Min(0) @Max(100000) repeaters: number;
  @IsInt() @Min(0) @Max(100000) dropoutCount: number;
}

// ─── Student register ─────────────────────────────────────────────────────────
export class StudentRecordDto {
  @IsString() @IsNotEmpty() @MaxLength(60) studentCode: string;
  @IsIn(inList(CLASS_LEVELS)) classLevel: string;
  @IsString() @IsNotEmpty() @MaxLength(80) firstName: string;
  @IsOptional() @IsString() @MaxLength(80) middleName?: string;
  @IsString() @IsNotEmpty() @MaxLength(80) lastName: string;
  @IsOptional() @IsDateString() dateOfBirth?: string;
  @IsIn(inList(GENDERS)) gender: string;

  @IsOptional() @IsIn(inList(NIGERIAN_STATES)) stateOfOrigin?: string;
  @IsOptional() @IsString() @MaxLength(80) lgaOfOrigin?: string;

  @IsOptional() @IsBoolean() disabilityStatus?: boolean;
  @IsOptional() @IsString() @MaxLength(120) disabilityType?: string;

  @IsIn(inList(ENROLMENT_TYPES)) enrolmentType: string;
  @IsOptional() @IsNumber() @Min(0) @Max(500) distanceToSchoolKm?: number;
  @IsOptional() @IsIn(inList(TRANSPORT_MODES)) transportMode?: string;
  @IsOptional() @IsString() @MaxLength(120) guardianName?: string;
  @IsOptional() @IsString() @MaxLength(40) guardianPhone?: string;
  @IsDateString() enrolmentDate: string;
  @IsOptional() @IsDateString() exitDate?: string;
  @IsOptional() @IsIn(inList(EXIT_REASONS)) exitReason?: string;
}

// ─── Staff register ───────────────────────────────────────────────────────────
export class StaffRecordDto {
  @IsString() @IsNotEmpty() @MaxLength(60) staffCode: string;
  @IsString() @IsNotEmpty() @MaxLength(80) firstName: string;
  @IsOptional() @IsString() @MaxLength(80) middleName?: string;
  @IsString() @IsNotEmpty() @MaxLength(80) lastName: string;
  @IsIn(inList(GENDERS)) gender: string;
  @IsOptional() @IsDateString() dateOfBirth?: string;
  @IsOptional() @IsString() @MaxLength(40) phoneNumber?: string;

  @IsIn(inList(STAFF_TYPES)) staffType: string;
  @IsIn(inList(EMPLOYMENT_TYPES)) employmentType: string;
  @IsIn(inList(QUALIFICATIONS)) qualification: string;
  @IsOptional() @IsString() @MaxLength(80) subject?: string;

  @IsOptional() @IsDateString() dateOfFirstAppointment?: string;
  @IsOptional() @IsDateString() datePostedToSchool?: string;
  @IsBoolean() isResidentInCommunity: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(80) yearsAtCurrentSchool?: number;
  @IsBoolean() isHeadTeacher: boolean;
}
