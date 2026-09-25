import { Body, Controller, Headers, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import {
  PAYMENT_GATEWAY_CLIENT,
  PaymentGatewayClient,
} from '../payments/payment-gateway.interface';
import { OrdersService } from './orders.service';

/**
 * Estrutura pronta pro dia em que um gateway real for escolhido (ver
 * roadmap-mercado-livre.md, seção 9 -- ainda em aberto, decisão do
 * Arthur). Rota única e genérica por provider (":provider" so identifica
 * qual foi chamado -- so um gateway fica ativo por vez, via
 * PAYMENT_GATEWAY_CLIENT em payments.module.ts, entao nao ha roteamento
 * de fato aqui, so o path que o dashboard de cada gateway vai pedir pra
 * cadastrar a URL do webhook).
 *
 * @Public() pelo mesmo motivo de PublicReviewsController: SessionAuthGuard/
 * RolesGuard sao globais -- um webhook de gateway de pagamento nunca chega
 * com sessao de cliente, entao teria 401 em toda tentativa sem isso.
 * Autenticidade do payload e responsabilidade de
 * PaymentGatewayClient.parseWebhook (assinatura/segredo compartilhado,
 * especifico de cada provedor) -- nao deste controller.
 *
 * Responde 200 sempre que o evento foi aceito e processado (inclusive
 * evento desconhecido/duplicado -- no-op idempotente dentro de
 * OrdersService.confirmPaymentFromWebhook, nao erro): gateways de
 * pagamento tratam qualquer resposta != 2xx como "falhou, tentar de
 * novo" e reentregam em loop, entao devolver 4xx/5xx pra um evento ja
 * tratado so geraria reentrega infinita sem necessidade. Falha de
 * assinatura/parse em parseWebhook (payload adulterado ou invalido)
 * continua propagando como erro normalmente -- isso NAO deve virar 200.
 */
@ApiTags('payment-webhooks')
@Controller('payments/webhooks')
@Public()
export class PaymentWebhooksController {
  constructor(
    @Inject(PAYMENT_GATEWAY_CLIENT)
    private readonly paymentGateway: PaymentGatewayClient,
    private readonly ordersService: OrdersService,
  ) {}

  @Post(':provider')
  @HttpCode(200)
  @ApiParam({ name: 'provider', example: 'mercadopago' })
  @ApiOperation({
    summary:
      'Recebe confirmação assíncrona de pagamento do gateway ativo (Pix/boleto). Payload e assinatura são específicos de cada provedor -- ver PaymentGatewayClient.parseWebhook.',
  })
  async handle(
    @Param('provider') provider: string,
    @Body() payload: unknown,
    @Headers() headers: Record<string, string>,
  ): Promise<{ received: true }> {
    const event = await this.paymentGateway.parseWebhook(provider, payload, headers);
    await this.ordersService.confirmPaymentFromWebhook(event);
    return { received: true };
  }
}
