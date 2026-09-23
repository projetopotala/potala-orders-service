/**
 * PostgreSQL int4 ceiling. Order/SellerOrder/OrderItem money columns are
 * Prisma Int (int4), same as catalog-service's price columns — see the
 * warning left in catalog-service's products.constants.ts (MAX_STOCK_QUANTITY)
 * anticipating exactly this service: MAX_PRICE_CENTS * MAX_STOCK_QUANTITY
 * there overflows int4 by far, so this service defines its own, much
 * smaller per-line quantity ceiling and explicitly checks every computed
 * sum (lineTotalCents, subtotalCents, totalCents) against this ceiling
 * before persisting, rather than trusting int4 to just not overflow.
 */
export const INT4_MAX = 2_147_483_647;

export const MIN_CHECKOUT_ITEMS = 1;
/** A single checkout resolves at most this many distinct variants — mirrors catalog-service's MAX_RESOLVE_VARIANT_IDS. */
export const MAX_CHECKOUT_ITEMS = 50;

export const MIN_ITEM_QUANTITY = 1;
/**
 * Ceiling for a single order line's quantity. Deliberately far below
 * catalog-service's MAX_STOCK_QUANTITY (1,000,000) — that bounds how much
 * stock a seller may hold, not how much a single customer may buy in one
 * checkout line.
 */
export const MAX_ITEM_QUANTITY = 1_000;

export const MAX_SHIPPING_FIELD_LENGTH = 200;
export const MAX_SHIPPING_COMPLEMENT_LENGTH = 200;
export const MAX_SHIPPING_STATE_LENGTH = 2;
export const MAX_SHIPPING_POSTAL_CODE_LENGTH = 20;

/** Whole-transaction retries when another request took the order number between generation and insert. */
export const MAX_ORDER_NUMBER_RETRIES = 3;

// --- Reviews (Fase B do roadmap pos-entrega, ver roadmap-mercado-livre.md) ---
export const MIN_REVIEW_RATING = 1;
export const MAX_REVIEW_RATING = 5;
export const MAX_REVIEW_COMMENT_LENGTH = 2000;
