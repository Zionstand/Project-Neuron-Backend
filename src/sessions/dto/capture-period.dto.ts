import {
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

// A capture round within a session (e.g. "Term 1"). The SysAdmin defines these;
// activation makes one current and closes the previously-current one.
export class CreateCapturePeriodDto {
  @IsString() @IsNotEmpty() @MaxLength(60) name: string;
  @IsOptional() @IsInt() @Min(1) sequence?: number;
  @IsOptional() @IsDateString() startDate?: string;
  @IsOptional() @IsDateString() endDate?: string;
}

export class UpdateCapturePeriodDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(60) name?: string;
  @IsOptional() @IsInt() @Min(1) sequence?: number;
  @IsOptional() @IsDateString() startDate?: string;
  @IsOptional() @IsDateString() endDate?: string;
}
