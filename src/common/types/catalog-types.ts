/**
 * Plain TS mirror of catalog-service's ProductStatus Prisma enum. orders-service
 * does not own the Product model — it lives in the `catalog` schema, a
 * separate service and database boundary — so this cannot come from this
 * service's own Prisma client. Same pattern used for identity-service's and
 * sellers-service's enums elsewhere in this project.
 *
 * Keep in sync with catalog-service's prisma/schema.prisma by hand.
 */
export enum ProductStatus {
  DRAFT = 'DRAFT',
  REVIEW = 'REVIEW',
  ACTIVE = 'ACTIVE',
  REJECTED = 'REJECTED',
  INACTIVE = 'INACTIVE',
}

/**
 * Shape returned by catalog-service's
 * POST /internal/product-variants/resolve — the authoritative
 * price/seller/status/stock data orders-service builds a checkout from. See
 * docs/internal-api-contract.md.
 */
export interface ResolvedProductVariant {
  variantId: string;
  productId: string;
  sellerId: string;
  productStatus: ProductStatus;
  productTitle: string;
  sku: string;
  variantName: string;
  unitPriceCents: number;
  availableQuantity: number;
}
