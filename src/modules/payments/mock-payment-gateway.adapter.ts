import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  PaymentChargeInput,
  PaymentChargeResult,
  PaymentGatewayClient,
} from './payment-gateway.interface';

/**
 * v1's only payment gateway. NOT a real integration — no payment gateway is
 * configured or decided anywhere in this project yet (see the architecture
 * analysis doc and README.md for the reasoning). This adapter exists so
 * checkout is fully functional end-to-end (reserve -> charge -> commit/
 * release) without blocking on a provider decision that is Arthur's to make,
 * not Claude's to assume.
 *
 * Deliberately always approves. The failure path (release stock, cancel the
 * order) is fully implemented in OrdersService and exercised in
 * orders.service.spec.ts by injecting a fake PaymentGatewayClient that
 * returns FAILED — not by a client-supplied "simulate failure" flag on the
 * checkout DTO, which would be a test-only backdoor baked into a production
 * request shape. A real gateway is swapped in later by implementing
 * PaymentGatewayClient and changing the provider binding in payments.module.ts
 * — nothing in OrdersService or the checkout DTO needs to change.
 */
@Injectable()
export class MockPaymentGatewayAdapter implements PaymentGatewayClient {
  private readonly logger = new Logger(MockPaymentGatewayAdapter.name);

  async charge(input: PaymentChargeInput): Promise<PaymentChargeResult> {
    this.logger.warn(
      `MOCK payment gateway: auto-approving order ${input.orderNumber} (${input.amountCents} cents). This is NOT a real charge -- see this file's own comment and README.md before deploying.`,
    );

    return {
      status: 'APPROVED',
      provider: 'mock',
      providerRef: `mock_${randomUUID()}`,
    };
  }
}
