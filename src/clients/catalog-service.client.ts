import {
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { ResolvedProductVariant } from '../common/types/catalog-types';
import { INTERNAL_API_KEY_HEADER } from '../common/constants/auth.constants';

export interface InventoryItemInput {
  variantId: string;
  quantity: number;
}

/**
 * This service has no local product/variant/price/stock data — that all
 * lives in catalog-service's own `catalog` schema, a separate service and
 * database boundary. This client is what makes checkout possible without
 * ever trusting productId/variantId/price/sellerId coming from orders-
 * service's own client. Added to catalog-service specifically for this
 * purpose — see its docs/internal-api-contract.md and this service's own
 * docs/internal-api-contract.md for the full two-sided contract.
 */
@Injectable()
export class CatalogServiceClient {
  private readonly logger = new Logger(CatalogServiceClient.name);

  constructor(private readonly configService: ConfigService<AppConfig, true>) {}

  /**
   * Calls catalog-service's POST /internal/product-variants/resolve. Ids
   * with no matching variant are simply absent from the returned array —
   * never an error at this layer; OrdersService is the one that decides a
   * missing id means an invalid cart line.
   */
  async resolveVariants(variantIds: string[]): Promise<ResolvedProductVariant[]> {
    const response = await this.post<ResolvedProductVariant[]>(
      '/api/v1/internal/product-variants/resolve',
      { variantIds },
    );
    return response;
  }

  /**
   * Atomically reserves stock for every item, all-or-nothing. Throws
   * ConflictException when catalog-service reports insufficient stock for
   * any item in the batch (the whole batch is rolled back there too — no
   * item ends up partially reserved).
   */
  async reserveInventory(items: InventoryItemInput[]): Promise<void> {
    await this.post('/api/v1/internal/inventory/reserve', { items });
  }

  /** Compensation path: undoes a previous reserveInventory call for a failed/expired checkout. */
  async releaseInventory(items: InventoryItemInput[]): Promise<void> {
    await this.post('/api/v1/internal/inventory/release', { items });
  }

  /** Turns a previous reservation into consumed stock once payment is approved. */
  async commitInventory(items: InventoryItemInput[]): Promise<void> {
    await this.post('/api/v1/internal/inventory/commit', { items });
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const { baseUrl, apiKey, timeoutMs } = this.configService.get(
      'catalogService',
      { infer: true },
    );

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [INTERNAL_API_KEY_HEADER]: apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      this.logger.error(`catalog-service unreachable: ${(error as Error).message}`);
      throw new ServiceUnavailableException(
        'Catalog service is unavailable. Try again shortly.',
      );
    } finally {
      clearTimeout(timeout);
    }

    if (response.ok) {
      return (await response.json()) as T;
    }

    if (response.status === 409) {
      throw new ConflictException('Insufficient stock for one or more items');
    }

    this.logger.error(
      `catalog-service returned unexpected status ${response.status} for ${path}`,
    );
    throw new ServiceUnavailableException(
      'Catalog service is unavailable. Try again shortly.',
    );
  }
}
