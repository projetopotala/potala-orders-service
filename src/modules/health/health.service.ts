import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

export type LivenessResult = { status: 'ok' };

export type ReadinessResult =
  | { status: 'ok'; database: 'up' }
  | { status: 'unavailable'; database: 'down' };

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(private readonly prisma: PrismaService) {}

  liveness(): LivenessResult {
    return { status: 'ok' };
  }

  /**
   * The caught error is intentionally discarded. Prisma connection failures
   * carry the connection string, host and credentials in both message and
   * stack, and a public probe is not the place to surface them. Both the log
   * line and the response body are fixed literals; diagnosing the outage is
   * the job of the database logs. Same as every other service in this
   * project: this only reports this service's own database, not
   * identity-service or catalog-service.
   */
  async readiness(): Promise<ReadinessResult> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', database: 'up' };
    } catch {
      this.logger.error('Readiness probe failed: database is unreachable');
      return { status: 'unavailable', database: 'down' };
    }
  }
}
