import { IsInt, IsNumber, IsOptional, Max, Min } from 'class-validator';

// Live GPS captured at the school gate (Field Capture Guide §1.4). The enumerator's
// device provides lat/lng + accuracy; the app averages a few samples.
export class CaptureGpsDto {
  @IsNumber() @Min(-90) @Max(90) latitude: number;
  @IsNumber() @Min(-180) @Max(180) longitude: number;
  @IsOptional() @IsNumber() @Min(0) accuracyMetres?: number;
  @IsOptional() @IsInt() @Min(1) sampleCount?: number;
}
