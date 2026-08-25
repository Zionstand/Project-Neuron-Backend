import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

// Self-service profile edit. Email, role and geographic scope are excluded by
// design — email is the login identity, and scope is an RBAC decision that
// belongs to a system administrator, not to the account holder.
export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  lastName?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\+?[0-9\s-]{7,20}$/, {
    message: 'phoneNumber must be a valid phone number',
  })
  phoneNumber?: string;
}
