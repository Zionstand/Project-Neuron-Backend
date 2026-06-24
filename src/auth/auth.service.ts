import {
  Injectable,
  ConflictException,
  InternalServerErrorException,
  BadRequestException,
  UnauthorizedException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { ForceChangePasswordDto } from './dto/force-change-password.dto';
import { MailService } from '../mail/mail.service';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import slugify from 'slugify';
import type { Response } from 'express';

// Shape needed to mint an access token. Kept loose so a freshly-fetched User row
// can be passed straight in.
type AccessTokenUser = {
  id: string;
  email: string;
  role: string;
  assignedLga: string | null;
  assignedZone: string | null;
  assignedCluster: string | null;
};

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private mailService: MailService,
  ) {}

  // --- Access token ---------------------------------------------------------
  // The signed JWT carries the single role claim and is delivered as an httpOnly
  // cookie. RBAC Rule 7: JWT httpOnly cookie. No localStorage. No exceptions.
  private async issueAccessToken(
    user: AccessTokenUser,
    res: Response,
  ): Promise<void> {
    const payload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      assignedLga: user.assignedLga,
      assignedZone: user.assignedZone,
      assignedCluster: user.assignedCluster,
    };

    const accessToken = await this.jwtService.signAsync(payload);

    res.cookie('access_token', accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      // Cross-site in production (frontend on Vercel, API on Render) requires
      // SameSite=None+Secure or the browser drops the cookie on XHR. Lax locally.
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      maxAge: 15 * 60 * 1000, // 15 minutes — matches JwtModule signOptions expiresIn
      path: '/',
    });
  }

  // --- Refresh token --------------------------------------------------------
  // Random opaque token, hashed at rest, delivered as a separate httpOnly cookie.
  private async issueRefreshToken(
    userId: string,
    res: Response,
    rememberMe = true,
  ): Promise<void> {
    const raw = randomBytes(32).toString('hex'); // 64 hex chars, within bcrypt's 72-byte limit
    const hash = await bcrypt.hash(raw, 10);
    await this.prisma.user.update({
      where: { id: userId },
      data: { refreshToken: hash },
    });
    res.cookie('refresh_token', `${userId}:${raw}`, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      // "Keep me signed in" => persistent 7-day cookie; otherwise a session cookie
      // that is cleared when the browser/PWA is closed.
      ...(rememberMe ? { maxAge: 7 * 24 * 60 * 60 * 1000 } : {}),
      path: '/',
    });
  }

  // Self-service registration only ever creates a PENDING LIE awaiting SYS_ADMIN
  // activation. Privileged roles (ZONAL_COORD, EMIS_OFFICER, HOD_APPROVE, etc.)
  // are provisioned exclusively by a SYS_ADMIN via POST /users — never here.
  // (RBAC Rule 6.) No token is issued; the account cannot log in until ACTIVE.
  async register(dto: RegisterDto) {
    if (dto.password !== dto.confirmPassword) {
      throw new BadRequestException('Passwords do not match');
    }

    try {
      const existingUser = await this.prisma.user.findFirst({
        where: {
          OR: [{ email: dto.email }, { phoneNumber: dto.phoneNumber }],
        },
      });

      if (existingUser) {
        throw new ConflictException(
          'A user with this email or phone number already exists.',
        );
      }

      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(dto.password, salt);

      const baseUsername = slugify(`${dto.firstName} ${dto.lastName}`, {
        lower: true,
        strict: true,
      });
      const randomString = Math.random().toString(36).substring(2, 6);
      const username = `${baseUsername}-${randomString}`;

      const newUser = await this.prisma.user.create({
        data: {
          firstName: dto.firstName,
          lastName: dto.lastName,
          email: dto.email,
          phoneNumber: dto.phoneNumber,
          password: hashedPassword,
          username,
          role: 'LIE', // never self-assign a privileged role
          assignedLga: dto.assignedLga ?? null,
        },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          username: true,
          email: true,
          role: true,
          assignedLga: true,
          accountStatus: true,
          createdAt: true,
        },
      });

      const fullName = `${newUser.firstName} ${newUser.lastName}`;
      this.mailService
        .sendNewStaffRegistrationEmail(fullName, newUser.email, newUser.role)
        .catch(() => {});

      return {
        message: 'Registration successful. Account is pending admin approval.',
        user: newUser,
      };
    } catch (error) {
      console.error('REGISTRATION ERROR:', error);
      if (
        error instanceof ConflictException ||
        error instanceof BadRequestException
      )
        throw error;
      throw new InternalServerErrorException(
        'An error occurred during registration.',
      );
    }
  }

  async login(dto: LoginDto, res: Response) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const isPasswordValid = await bcrypt.compare(dto.password, user.password);

    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Force temporary-password change before anything else.
    if (user.requiresPasswordChange) {
      return {
        requiresPasswordChange: true,
        email: user.email,
        message: 'You must change your temporary password before logging in.',
      };
    }

    // Block pending / rejected / suspended accounts.
    if (user.accountStatus !== 'ACTIVE') {
      throw new UnauthorizedException(
        `Account is currently ${user.accountStatus}. Please await admin action.`,
      );
    }

    await this.issueAccessToken(user, res);
    await this.issueRefreshToken(user.id, res, dto.rememberMe ?? false);

    // The access token is NOT returned in the body — it lives in the httpOnly
    // cookie only (Rule 7). The client reads identity from this payload + /auth/me.
    return {
      message: 'Login successful',
      user: {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role,
        accountStatus: user.accountStatus,
        assignedLga: user.assignedLga,
        assignedZone: user.assignedZone,
        assignedCluster: user.assignedCluster,
      },
    };
  }

  async forgotPassword(dto: ForgotPasswordDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (!user) {
      return { message: 'If that email exists, an OTP has been sent to it.' };
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = new Date();
    expires.setMinutes(expires.getMinutes() + 10);

    await this.prisma.user.update({
      where: { email: dto.email },
      data: { resetOTP: otp, resetOTPExpiry: expires },
    });

    await this.mailService.sendPasswordResetOtp(user.email, otp);

    return { message: 'If that email exists, an OTP has been sent to it.' };
  }

  async verifyOtp(dto: VerifyOtpDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (!user) throw new NotFoundException('User not found');
    if (user.resetOTP !== dto.otp)
      throw new BadRequestException('Invalid OTP code');
    if (!user.resetOTPExpiry || user.resetOTPExpiry < new Date()) {
      throw new BadRequestException(
        'OTP has expired. Please request a new one.',
      );
    }

    return { message: 'OTP is valid! You can now reset your password.' };
  }

  async resetPassword(dto: ResetPasswordDto) {
    if (dto.newPassword !== dto.confirmPassword) {
      throw new BadRequestException('Passwords do not match');
    }

    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (!user) throw new NotFoundException('User not found');

    if (
      user.resetOTP !== dto.otp ||
      !user.resetOTPExpiry ||
      user.resetOTPExpiry < new Date()
    ) {
      throw new BadRequestException('Invalid or expired OTP');
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(dto.newPassword, salt);

    await this.prisma.user.update({
      where: { email: dto.email },
      data: { password: hashedPassword, resetOTP: null, resetOTPExpiry: null },
    });

    return {
      message: 'Password has been reset successfully. You can now log in.',
    };
  }

  async forceChangePassword(dto: ForceChangePasswordDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const isPasswordValid = await bcrypt.compare(
      dto.oldPassword,
      user.password,
    );
    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid current password');
    }

    if (!user.requiresPasswordChange) {
      throw new BadRequestException(
        'Password change is not required for this account',
      );
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(dto.newPassword, salt);

    await this.prisma.user.update({
      where: { email: dto.email },
      data: {
        password: hashedPassword,
        requiresPasswordChange: false,
      },
    });

    return {
      message:
        'Password updated successfully. You can now log in with your new password.',
    };
  }

  async refresh(cookieValue: string | undefined, res: Response) {
    if (!cookieValue) throw new UnauthorizedException('No refresh token');

    const [userId, rawToken] = cookieValue.split(':');
    if (!userId || !rawToken)
      throw new UnauthorizedException('Malformed refresh token');

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user || !user.refreshToken)
      throw new UnauthorizedException('Refresh token revoked');

    const isValid = await bcrypt.compare(rawToken, user.refreshToken);
    if (!isValid) throw new UnauthorizedException('Invalid refresh token');

    if (user.accountStatus !== 'ACTIVE') {
      throw new UnauthorizedException(`Account is ${user.accountStatus}`);
    }

    await this.issueAccessToken(user, res);
    await this.issueRefreshToken(user.id, res); // rotate the refresh token

    return { message: 'Token refreshed' };
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ) {
    if (!currentPassword || !newPassword) {
      throw new BadRequestException(
        'Both current and new password are required.',
      );
    }
    if (newPassword.length < 8) {
      throw new BadRequestException(
        'New password must be at least 8 characters.',
      );
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found.');

    const isValid = await bcrypt.compare(currentPassword, user.password);
    if (!isValid)
      throw new UnauthorizedException('Current password is incorrect.');

    if (currentPassword === newPassword) {
      throw new BadRequestException(
        'New password must be different from your current password.',
      );
    }

    const salt = await bcrypt.genSalt(10);
    const hashed = await bcrypt.hash(newPassword, salt);

    await this.prisma.user.update({
      where: { id: userId },
      data: { password: hashed, refreshToken: null },
    });

    return { message: 'Password changed successfully. Please log in again.' };
  }

  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        username: true,
        phoneNumber: true,
        accountStatus: true,
        requiresPasswordChange: true,
        createdAt: true,
        role: true,
        assignedLga: true,
        assignedZone: true,
        assignedCluster: true,
      },
    });
    if (!user) throw new NotFoundException('User not found.');
    return user;
  }

  async logout(userId: string, res: Response) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { refreshToken: null },
    });
    // Attributes must match those used when setting the cookie, or the browser
    // won't match-and-clear the cross-site cookie.
    const clearOpts = {
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: (process.env.NODE_ENV === 'production' ? 'none' : 'lax') as
        | 'none'
        | 'lax',
    };
    res.clearCookie('access_token', clearOpts);
    res.clearCookie('refresh_token', clearOpts);
    return { message: 'Logged out successfully' };
  }
}
