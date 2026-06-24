import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Global module — PrismaService is provided once and shared across the entire
 * application. This ensures a single PrismaClient instance (and a single
 * connection pool) rather than one per feature module, which would exhaust
 * Neon's concurrent-connection limit.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
