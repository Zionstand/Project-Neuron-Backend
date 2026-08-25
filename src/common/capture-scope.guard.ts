import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CAPTURE_SECTION_KEY } from './capture-scope.decorator';
import {
  isSectionEnabled,
  isScopeExempt,
  OUT_OF_SCOPE_MESSAGE,
  type CaptureSectionKey,
} from './capture-scope';

// Refuses routes whose capture section is switched off for the current exercise.
// Runs after RolesGuard, so by this point req.user carries a verified role claim.
@Injectable()
export class CaptureScopeGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const section = this.reflector.getAllAndOverride<CaptureSectionKey>(
      CAPTURE_SECTION_KEY,
      [context.getHandler(), context.getClass()],
    );

    // Unmarked route — nothing to gate.
    if (!section) return true;
    if (isSectionEnabled(section)) return true;

    const { user } = context.switchToHttp().getRequest();
    if (isScopeExempt(user?.role)) return true;

    throw new ForbiddenException(OUT_OF_SCOPE_MESSAGE);
  }
}
