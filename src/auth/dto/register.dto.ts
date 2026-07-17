import {
  IsString,
  IsEmail,
  IsNotEmpty,
  MinLength,
  IsOptional,
  IsIn,
} from 'class-validator';

// Self-service registration creates a PENDING account awaiting SYS_ADMIN approval.
// The default (no `role`) is an LIE. The one other self-service path is PRINCIPAL:
// a school head who picks their school; the admin confirms the binding on approval.
// Every privileged role is still provisioned exclusively by a SYS_ADMIN (RBAC Rule 6).
export class RegisterDto {
  @IsString()
  @IsNotEmpty()
  firstName: string;

  @IsString()
  @IsNotEmpty()
  lastName: string;

  @IsEmail()
  @IsNotEmpty()
  email: string;

  @IsString()
  @IsNotEmpty()
  phoneNumber: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(8, { message: 'Password must be at least 8 characters long' })
  password: string;

  @IsString()
  @IsNotEmpty()
  confirmPassword: string;

  // Optional LGA the inspector is assigned to (service-layer scoping, Rule 3).
  @IsString()
  @IsOptional()
  assignedLga?: string;

  // Self-service role. Only PRINCIPAL is accepted here; anything else is ignored
  // and the account defaults to LIE. Privileged roles are admin-provisioned.
  @IsOptional()
  @IsIn(['PRINCIPAL'])
  role?: 'PRINCIPAL';

  // The school a self-registering principal is requesting to manage. Confirmed by
  // the SYS_ADMIN at approval time.
  @IsString()
  @IsOptional()
  requestedSchoolId?: string;
}
