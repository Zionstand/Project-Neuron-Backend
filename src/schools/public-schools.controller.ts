import { Controller, Get } from '@nestjs/common';
import { SchoolsService } from './schools.service';

// Unauthenticated school directory used by the self-registration school picker
// (a prospective principal has no account yet). Deliberately NOT behind
// JwtAuthGuard/RolesGuard. Returns PII-free identifiers only.
@Controller('public/schools')
export class PublicSchoolsController {
  constructor(private readonly schoolsService: SchoolsService) {}

  @Get()
  list() {
    return this.schoolsService.listPublic();
  }
}
