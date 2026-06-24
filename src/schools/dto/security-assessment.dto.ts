import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

// Fixed option sets from the Field Capture Guide §5. Exported so the service can
// reuse them and the frontend stays in sync with one source of truth.
export const ROAD_SURFACE_TYPES = [
  'Tarmac',
  'Laterite',
  'Gravel',
  'Footpath Only',
  'None',
] as const;
export const FOREST_PROXIMITIES = [
  'Adjacent',
  'Near',
  'Moderate',
  'Distant',
] as const;
export const FENCE_STATUSES = ['None', 'Partial', 'Full'] as const;
export const FENCE_TYPES = [
  'Concrete Block',
  'Wire Mesh',
  'Wooden',
  'Mixed',
  'None',
] as const;
export const NETWORK_PROVIDERS = [
  'MTN',
  'Airtel',
  'Glo',
  '9mobile',
  'None',
  'Multiple',
] as const;
export const SIGNAL_STRENGTHS = ['Strong', 'Weak', 'None'] as const;
export const INCIDENT_TYPES = [
  'Threat',
  'Robbery',
  'Abduction',
  'Physical Attack',
  'Vandalism',
  'Other',
] as const;

// Every field is optional so a partial draft can be saved. The submit endpoint
// enforces the required core (see SchoolsService.REQUIRED_FOR_SUBMIT).
export class SecurityAssessmentDto {
  // Module A — Location & Access
  @IsOptional() @IsNumber() @Min(0) @Max(500)
  distanceToMajorRoadKm?: number;

  @IsOptional() @IsIn(ROAD_SURFACE_TYPES as unknown as string[])
  roadSurfaceType?: string;

  @IsOptional() @IsInt() @Min(0) @Max(1440)
  estimatedTravelTimeMins?: number;

  @IsOptional() @IsString() @MaxLength(120)
  nearestTown?: string;

  @IsOptional() @IsIn(FOREST_PROXIMITIES as unknown as string[])
  forestProximity?: string;

  @IsOptional() @IsNumber() @Min(0) @Max(500)
  forestDistanceEstimateKm?: number;

  // Module B — Physical Infrastructure & Perimeter
  @IsOptional() @IsIn(FENCE_STATUSES as unknown as string[])
  perimeterFenceStatus?: string;

  @IsOptional() @IsIn(FENCE_TYPES as unknown as string[])
  fenceType?: string;

  @IsOptional() @IsInt() @Min(0) @Max(100)
  numberOfEntryPoints?: number;

  @IsOptional() @IsBoolean() hasFunctionalGate?: boolean;
  @IsOptional() @IsBoolean() hasCctv?: boolean;
  @IsOptional() @IsBoolean() hasElectricity?: boolean;
  @IsOptional() @IsBoolean() hasSolar?: boolean;
  @IsOptional() @IsBoolean() hasExternalLighting?: boolean;

  // Module C — Communication & Emergency Capacity
  @IsOptional() @IsBoolean() hasPhoneNetwork?: boolean;

  @IsOptional() @IsIn(NETWORK_PROVIDERS as unknown as string[])
  networkProvider?: string;

  @IsOptional() @IsIn(SIGNAL_STRENGTHS as unknown as string[])
  signalStrength?: string;

  @IsOptional() @IsBoolean() hasLandline?: boolean;
  @IsOptional() @IsBoolean() hasRadioSet?: boolean;
  @IsOptional() @IsBoolean() hasEmergencyProtocol?: boolean;

  @IsOptional() @IsNumber() @Min(0) @Max(500)
  distanceToSecurityPostKm?: number;

  @IsOptional() @IsString() @MaxLength(120)
  nearestSecurityPostName?: string;

  // Module D — Incident History
  @IsOptional() @IsBoolean() hadSecurityIncident?: boolean;

  @IsOptional() @IsInt() @Min(0) @Max(1000)
  incidentCount?: number;

  @IsOptional() @IsInt() @Min(1980) @Max(2100)
  mostRecentIncidentYear?: number;

  @IsOptional() @IsIn(INCIDENT_TYPES as unknown as string[])
  mostRecentIncidentType?: string;

  @IsOptional() @IsBoolean() incidentReportedToAuth?: boolean;
}
