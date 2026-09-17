import { Module } from '@nestjs/common';
import { MockPaymentGatewayAdapter } from './mock-payment-gateway.adapter';
import { PAYMENT_GATEWAY_CLIENT } from './payment-gateway.interface';

/**
 * The only place a real gateway integration is wired in later: replace
 * `useClass: MockPaymentGatewayAdapter` with a real adapter implementing
 * PaymentGatewayClient. Nothing outside this module needs to change —
 * OrdersService only ever depends on the PAYMENT_GATEWAY_CLIENT token.
 */
@Module({
  providers: [
    { provide: PAYMENT_GATEWAY_CLIENT, useClass: MockPaymentGatewayAdapter },
  ],
  exports: [PAYMENT_GATEWAY_CLIENT],
})
export class PaymentsModule {}
