import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { AuthenticatedUser } from '../common/types/authenticated-user';
import { INTERNAL_API_KEY_HEADER } from '../common/constants/auth.constants';

/**
 * Mirror of sellers-service's and catalog-service's own IdentityServiceClient
 * (same problem: this service has no local session table, so every
 * authenticated request needs identity-service to resolve the raw cookie
 * token). Only needs introspectSession, not getUserById — same reasoning as
 * catalog-service.
 */
@Injectable()
export class IdentityServiceClient {
  private readonly logger = new Logger(IdentityServiceClient.name);

  constructor(private readonly configService: ConfigService<AppConfig, true>) {}

  /**
   * Resolves a raw session-cookie token via identity-service's
   * POST /internal/sessions/introspect. Returns null for an invalid,
   * expired, revoked or BLOCKED-user session (caller should respond 401),
   * and throws ServiceUnavailableException if identity-service itself is
   * unreachable or misbehaving (caller should respond 503, never silently
   * treat that as "not authenticated").
   */
  async introspectSession(token: string): Promise<AuthenticatedUser | null> {
    const { baseUrl, apiKey, timeoutMs } = this.configService.get(
      'identityService',
      { infer: true },
    );

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/api/v1/internal/sessions/introspect`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [INTERNAL_API_KEY_HEADER]: apiKey,
        },
        body: JSON.stringify({ token }),
        signal: controller.signal,
      });
    } catch (error) {
      this.logger.error(
        `identity-service unreachable: ${(error as Error).message}`,
      );
      throw new ServiceUnavailableException(
        'Authentication service is unavailable. Try again shortly.',
      );
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 200) {
      return (await response.json()) as AuthenticatedUser;
    }

    if (response.status === 401) {
      return null;
    }

    this.logger.error(
      `identity-service returned unexpected status ${response.status} for session introspect`,
    );
    throw new ServiceUnavailableException(
      'Authentication service is unavailable. Try again shortly.',
    );
  }
}
