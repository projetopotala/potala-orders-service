import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { SellerOrdersController } from './seller-orders.controller';
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
import { ReturnsService } from './returns.service';
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
 */
@Module({
  imports: [PaymentsModule],
  controllers: [
    OrdersController,
    SellerOrdersController,
    AdminOrdersController,
    SellerReviewsController,
    PublicReviewsController,
    PaymentWebhooksController,
    AdminCouponsController,
    SellerCouponsController,
    AdminReturnsController,
  ],
  providers: [OrdersService, ReviewsService, CouponsService, ReturnsService],
})
export class OrdersModule {}
