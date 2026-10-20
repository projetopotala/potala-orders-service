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

/**
 * F2.1 -- idempotência do checkout (header `Idempotency-Key`). A chave é
 * opaca para o servidor; o frontend usa um UUID v4 por tentativa de compra.
 * 16..128 caracteres de um alfabeto sem espaço nem vírgula (cabeçalhos
 * repetidos chegam unidos por ", " e são recusados por este padrão).
 */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';
export const CHECKOUT_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;
/**
 * Validade da posse de uma chave ANTES de o pedido existir (resolução no
 * catalog-service + cupom). Vencida sem pedido criado, a chave pode ser
 * retomada por um retry; depois que o pedido existe, ela nunca é
 * reexecutada. Folga ampla sobre CATALOG_SERVICE_TIMEOUT_MS (padrão 5 s).
 */
export const CHECKOUT_IDEMPOTENCY_LEASE_MS = 60_000;
/** Tentativas de reler/retomar uma chave disputada antes de responder 409. */
export const CHECKOUT_IDEMPOTENCY_MAX_CLAIM_ATTEMPTS = 3;

// --- Reviews (Fase B do roadmap pos-entrega, ver roadmap-mercado-livre.md) ---
export const MIN_REVIEW_RATING = 1;
export const MAX_REVIEW_RATING = 5;
export const MAX_REVIEW_COMMENT_LENGTH = 2000;

// --- Cupons (pedido de Arthur, urgente -- ver status-migracao-microservicos.md) ---
export const MIN_COUPON_CODE_LENGTH = 3;
export const MAX_COUPON_CODE_LENGTH = 30;
export const MAX_COUPON_NAME_LENGTH = 200;
/** Percentual: 1-100. Valor fixo: 1 até este teto (centavos) -- mesma ordem de grandeza de MAX_ITEM_QUANTITY acima, generoso o bastante pra qualquer desconto real, longe do teto do int4. */
export const MAX_COUPON_FIXED_DISCOUNT_CENTS = 1_000_000;
export const MAX_PERCENT_DISCOUNT = 100;

// --- Devoluções (Fase E do roadmap pós-entrega adiantada -- ver roadmap-mercado-livre.md, seção 3) ---
export const MAX_RETURN_REASON_LENGTH = 200;
export const MAX_RETURN_DESCRIPTION_LENGTH = 2000;

// --- Pós-venda: Claims/Disputes (fundação P0, ver claude/plano-pos-venda-reclamacoes-devolucoes-disputas.md) ---
export const MAX_CLAIM_REASON_LENGTH = 200;
export const MAX_CLAIM_DESCRIPTION_LENGTH = 2000;
export const MAX_CLAIM_MESSAGE_LENGTH = 4000;
export const MAX_CLAIM_EVIDENCE_FILE_NAME_LENGTH = 255;
export const MAX_CLAIM_EVIDENCE_MIME_TYPE_LENGTH = 100;
export const MAX_CLAIM_EVIDENCE_STORAGE_KEY_LENGTH = 1000;
export const MAX_DISPUTE_DECISION_REASON_LENGTH = 2000;
