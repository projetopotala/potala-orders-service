import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { CheckoutIdempotencyService } from './checkout-idempotency.service';
import { OrderTransitionsService } from './order-transitions.service';
import { CustomerClaimsController } from './customer-claims.controller';
import { SellerOrdersController } from './seller-orders.controller';
import { SellerClaimsController } from './seller-claims.controller';
import { SellerReturnsController } from './seller-returns.controller';
import { AdminClaimsController } from './admin-claims.controller';
import { AdminDisputesController } from './admin-disputes.controller';
import { AdminOrdersController } from './admin-orders.controller';
import { SellerReviewsController } from './seller-reviews.controller';
import { PublicReviewsController } from './public-reviews.controller';
import { PaymentWebhooksController } from './payment-webhooks.controller';
import { AdminCouponsController } from './admin-coupons.controller';
import { SellerCouponsController } from './seller-coupons.controller';
import { AdminReturnsController } from './admin-returns.controller';
import { OrdersService } from './orders.service';
import { ReviewsService } from './reviews.service';
import { CouponsService } from './coupons.service';
import { FavoritesService } from './favorites.service';
import { ReturnsService } from './returns.service';
import { ClaimsService } from './claims.service';
import { DisputesService } from './disputes.service';
import { PaymentsModule } from '../payments/payments.module';

/**
 * ClientsModule (CatalogServiceClient, SellersServiceClient) and
 * PrismaModule are both @Global(), so neither is imported here explicitly
 * — same pattern every other feature module in this project follows.
 * PaymentsModule is not global (it is specific to checkout), so it is
 * imported directly. SellerOrdersController, PublicReviewsController and
 * PaymentWebhooksController live in this module (not separate ones) for
 * the same reason catalog-service keeps SellerProductsController alongside
 * its public controller — Fase B (avaliação e reputação) and Fase C
 * (pagamento real, ainda sem gateway escolhido — ver
 * roadmap-mercado-livre.md, seções 6 e 9) não justificam módulo próprio:
 * são concerns pequenos e diretamente ligados ao mesmo Prisma schema que
 * OrdersService já possui. AdminCouponsController/SellerCouponsController
 * seguem o mesmo raciocínio para Coupon (pedido de Arthur, urgente -- ver
 * comentário no model Coupon em schema.prisma). AdminReturnsController
 * segue o mesmo raciocínio para Return (ver comentário no model Return).
 *
 * ClaimsService/DisputesService (pós-venda, fundação P0 -- ver
 * claude/plano-pos-venda-reclamacoes-devolucoes-disputas.md) agora têm
 * sua camada HTTP: CustomerClaimsController, SellerClaimsController,
 * AdminClaimsController e AdminDisputesController (ver cada arquivo
 * para o detalhe de rotas/guards/actor). Nenhum dos dois services foi
 * duplicado como provider -- já estavam registrados abaixo desde a
 * fundação.
 *
 * CustomerClaimsController precisa estar ANTES de OrdersController no
 * array abaixo: GET /orders/claims (1 segmento estático) colide em
 * forma com GET /orders/:id (1 segmento dinâmico) de OrdersController,
 * e quem for registrado primeiro ganha o match (ver comentário na
 * própria CustomerClaimsController). Os demais três controllers novos
 * usam prefixos literais próprios (seller/claims, seller/returns/
 * .../dispute, admin/claims, admin/returns/.../dispute, admin/disputes)
 * sem colisão de forma com nenhuma rota existente, então sua posição
 * no array é irrelevante.
 */
@Module({
  imports: [PaymentsModule],
  controllers: [
    CustomerClaimsController,
    OrdersController,
    SellerOrdersController,
    SellerClaimsController,
    SellerReturnsController,
    AdminOrdersController,
    SellerReviewsController,
    PublicReviewsController,
    PaymentWebhooksController,
    AdminCouponsController,
    SellerCouponsController,
    AdminReturnsController,
    AdminClaimsController,
    AdminDisputesController,
  ],
  providers: [
    OrdersService,
    CheckoutIdempotencyService,
    OrderTransitionsService,
    ReviewsService,
    CouponsService,
    ReturnsService,
    FavoritesService,
    ClaimsService,
    DisputesService,
  ],
})
export class OrdersModule {}
