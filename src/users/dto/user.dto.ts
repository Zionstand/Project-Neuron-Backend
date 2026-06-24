import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ALL_ROLES } from '../../common/roles.constants';

const ROLES = ALL_ROLES as unknown as string[];

// Provision a privileged account directly (RBAC Rule 6 — SYS_ADMIN only). A
// temporary password is generated server-side and returned once.
export class ProvisionUserDto {
  @IsString() @IsNotEmpty() @MaxLength(80) firstName: string;
  @IsString() @IsNotEmpty() @MaxLength(80) lastName: string;
  @IsEmail() email: string;
  @IsString() @IsNotEmpty() @MaxLength(40) phoneNumber: string;
  @IsIn(ROLES) role: string;
  @IsOptional() @IsString() @MaxLength(120) assignedLga?: string;
  @IsOptional() @IsString() @MaxLength(120) assignedZone?: string;
  @IsOptional() @IsString() @MaxLength(120) assignedCluster?: string;
}

// Approve a PENDING registration — this is where the real role + scope are set.
export class ApproveUserDto {
  @IsIn(ROLES) role: string;
  @IsOptional() @IsString() @MaxLength(120) assignedLga?: string;
  @IsOptional() @IsString() @MaxLength(120) assignedZone?: string;
  @IsOptional() @IsString() @MaxLength(120) assignedCluster?: string;
}

export class RejectUserDto {
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

// Edit an existing user's role / geographic scope.
export class UpdateUserDto {
  @IsIn(ROLES) role: string;
  @IsOptional() @IsString() @MaxLength(120) assignedLga?: string;
  @IsOptional() @IsString() @MaxLength(120) assignedZone?: string;
  @IsOptional() @IsString() @MaxLength(120) assignedCluster?: string;
}

export const STATUS_ACTIONS = [
  'SUSPEND',
  'REACTIVATE',
  'BAN',
  'DEACTIVATE',
] as const;

export class StatusActionDto {
  @IsIn(STATUS_ACTIONS as unknown as string[]) action: string;
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}
