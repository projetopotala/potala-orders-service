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
 *
 * Gateway ainda não escolhido (ver roadmap-mercado-livre.md, seção 9) — o
 * que segue é a parte do contrato que já dá pra fixar hoje porque é comum
 * aos 4 candidatos levantados (Mercado Pago, Stripe, Pagar.me, Asaas):
 * nenhum deles confirma Pix/boleto de forma síncrona (por isso `PENDING` e
 * `parseWebhook` abaixo), e todos suportam algum tipo de split multi-
 * vendedor (por isso `splits`, opcional — um gateway que não suportar
 * split nativamente simplesmente ignora o campo). O que É específico de
 * cada gateway (autenticação, formato de payload, nome dos campos) fica
 * de fora de propósito — só existe dentro do adapter real, quando for
 * escrito.
 */
export interface PaymentSplitRecipient {
  sellerId: string;
  amountCents: number;
}

export interface PaymentChargeInput {
  orderId: string;
  orderNumber: string;
  amountCents: number;
  /**
   * Um vendedor por SellerOrder do pedido (ver OrdersService.checkout) —
   * soma sempre bate com amountCents. Best-effort: nenhum vendedor tem
   * conta/recebedor cadastrado em gateway nenhum ainda (isso é onboarding/
   * KYC por vendedor, trabalho de quando o gateway for escolhido), então
   * hoje isso só documenta a intenção. Um adapter sem suporte a split
   * (ou um MVP que ainda concentra tudo na conta do marketplace) ignora
   * o campo com segurança.
   */
  splits?: PaymentSplitRecipient[];
}

/**
 * PENDING = gateway aceitou a cobrança mas ainda não confirmou (típico de
 * Pix/boleto: o cliente ainda precisa pagar). Nesse caso o pedido fica em
 * PENDING_PAYMENT (já é o status default de Order) e a confirmação vem
 * depois via parseWebhook — ver OrdersService.confirmPaymentFromWebhook.
 */
export type PaymentChargeStatus = 'APPROVED' | 'PENDING' | 'FAILED';

export interface PaymentChargeResult {
  status: PaymentChargeStatus;
  provider: string;
  providerRef: string;
}

/** Resultado já normalizado de um webhook — nunca PENDING (um webhook não avisa "ainda pendente", só resolve). */
export interface PaymentWebhookEvent {
  provider: string;
  providerRef: string;
  status: Extract<PaymentChargeStatus, 'APPROVED' | 'FAILED'>;
}

export interface PaymentGatewayClient {
  charge(input: PaymentChargeInput): Promise<PaymentChargeResult>;
  /**
   * Traduz o payload cru de um webhook (formato 100% específico de cada
   * gateway) pro formato canônico acima. Deve validar a assinatura/
   * autenticidade do webhook internamente (mecanismo também específico de
   * cada gateway) e lançar erro se inválido — PaymentWebhooksController
   * (orders.module.ts) não confia em payload não verificado.
   */
  parseWebhook(
    provider: string,
    payload: unknown,
    headers: Record<string, string>,
  ): Promise<PaymentWebhookEvent>;
}

/** DI token — see payments.module.ts. */
export const PAYMENT_GATEWAY_CLIENT = 'PAYMENT_GATEWAY_CLIENT';
