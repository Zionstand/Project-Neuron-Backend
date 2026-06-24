import { IsBoolean, IsEmail, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class LoginDto {
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @IsString()
  @IsNotEmpty()
  password: string;

  // "Keep me signed in" — controls refresh-token cookie lifetime (persistent vs session).
  @IsBoolean()
  @IsOptional()
  rememberMe?: boolean;
}
