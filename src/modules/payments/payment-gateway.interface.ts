/**
 * Provider-agnostic charge interface. This is the seam a real gateway
 * (Mercado Pago, Stripe, Pagar.me, ...) plugs into later — see
 * mock-payment-gateway.adapter.ts for the v1 implementation and
 * docs/internal-api-contract.md / README.md for the decision behind it.
 *
 * The shape matches what PaymentTransaction (prisma/schema.prisma) already
 * expects: a provider name and a provider-side reference, exactly the pair
 * the monolith's original schema comments anticipated ("On webhook/success:
 * InventoryService.commitReservedStock()").
 */
export interface PaymentChargeInput {
  orderId: string;
  orderNumber: string;
  amountCents: number;
}

export type PaymentChargeStatus = 'APPROVED' | 'FAILED';

export interface PaymentChargeResult {
  status: PaymentChargeStatus;
  provider: string;
  providerRef: string;
}

export interface PaymentGatewayClient {
  charge(input: PaymentChargeInput): Promise<PaymentChargeResult>;
}

/** DI token — see payments.module.ts. */
export const PAYMENT_GATEWAY_CLIENT = 'PAYMENT_GATEWAY_CLIENT';
