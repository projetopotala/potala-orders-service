import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { SellerContext } from '../common/types/authenticated-user';
import { INTERNAL_API_KEY_HEADER } from '../common/constants/auth.constants';

/**
 * Needed for the seller-orders read endpoints (GET /seller/orders,
 * GET /seller/orders/:id): this service has no local `membros_vendedor`
 * table, so resolving "which sellerId does this authenticated user act as"
 * means calling sellers-service's own GET /internal/sellers/membership/:userId
 * over the network instead of a local Prisma query — the same client
 * catalog-service already has for its own seller-scoped routes. See this
 * service's own docs/internal-api-contract.md and sellers-service's for the
 * two-sided contract.
 */
@Injectable()
export class SellersServiceClient {
  private readonly logger = new Logger(SellersServiceClient.name);

  constructor(private readonly configService: ConfigService<AppConfig, true>) {}

  /**
   * Calls sellers-service's GET /internal/sellers/membership/:userId.
   * Returns null when the user has no store membership (caller should
   * respond 403, exactly like sellers-service's own local SellerContextGuard
   * does for the same case), and throws ServiceUnavailableException if
   * sellers-service itself is unreachable or misbehaving (caller should
   * respond 503, never silently treat that as "no membership").
   */
  async getMembershipByUserId(userId: string): Promise<SellerContext | null> {
    const { baseUrl, apiKey, timeoutMs } = this.configService.get(
      'sellersService',
      { infer: true },
    );

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(
        `${baseUrl}/api/v1/internal/sellers/membership/${userId}`,
        {
          method: 'GET',
          headers: { [INTERNAL_API_KEY_HEADER]: apiKey },
          signal: controller.signal,
        },
      );
    } catch (error) {
      this.logger.error(
        `sellers-service unreachable: ${(error as Error).message}`,
      );
      throw new ServiceUnavailableException(
        'Seller service is unavailable. Try again shortly.',
      );
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 200) {
      return (await response.json()) as SellerContext;
    }

    if (response.status === 404) {
      return null;
    }

    this.logger.error(
      `sellers-service returned unexpected status ${response.status} for membership lookup`,
    );
    throw new ServiceUnavailableException(
      'Seller service is unavailable. Try again shortly.',
    );
  }
}
