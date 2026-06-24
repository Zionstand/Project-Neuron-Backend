import {
  IsString,
  IsEmail,
  IsNotEmpty,
  MinLength,
  IsOptional,
} from 'class-validator';

// Self-service registration creates a PENDING LIE only (RBAC Rule 6). There is no
// role selection here — privileged roles are provisioned by a SYS_ADMIN.
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
}
