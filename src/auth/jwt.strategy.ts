import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-jwt';
import type { Request } from 'express';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { AccountStatus } from '../generated/prisma/client';
import { accountBlockedPayload } from '../common/account-status';

// RBAC Rule 7: the JWT is read from the httpOnly cookie ONLY — never from the
// Authorization header, never from localStorage. cookie-parser populates req.cookies.
const cookieExtractor = (req: Request): string | null => {
  return req?.cookies?.access_token ?? null;
};

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: cookieExtractor,
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET')!,
    });
  }

  async validate(payload: any) {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
    });

    if (!user) throw new UnauthorizedException('User no longer exists');

    // Status is re-read from the database on EVERY request, so an administrator
    // suspending, banning or deactivating someone takes effect on their very next
    // action — an already-issued token buys them nothing. The payload carries the
    // ACCOUNT_BLOCKED code the client uses to tear the session down and redirect.
    if (user.isDeleted) {
      throw new UnauthorizedException('User no longer exists');
    }

    if (user.accountStatus !== AccountStatus.ACTIVE) {
      throw new ForbiddenException(
        accountBlockedPayload(user.accountStatus, user.accountStatusReason),
      );
    }

    // What lands on request.user. `sub` is exposed for the media ownership check
    // (inspection.inspector_id === request.user.sub, RBAC Rule 4). The single
    // `role` claim is what the RolesGuard reads.
    return {
      id: user.id,
      sub: user.id,
      email: user.email,
      role: user.role,
      assignedLga: user.assignedLga,
      assignedZone: user.assignedZone,
      assignedCluster: user.assignedCluster,
      assignedSchoolId: user.assignedSchoolId,
    };
  }
}
