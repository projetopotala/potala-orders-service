import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { SellerOrdersController } from './seller-orders.controller';
import { PublicReviewsController } from './public-reviews.controller';
import { OrdersService } from './orders.service';
import { ReviewsService } from './reviews.service';
import { PaymentsModule } from '../payments/payments.module';

/**
 * ClientsModule (CatalogServiceClient, SellersServiceClient) and
 * PrismaModule are both @Global(), so neither is imported here explicitly
 * — same pattern every other feature module in this project follows.
 * PaymentsModule is not global (it is specific to checkout), so it is
 * imported directly. SellerOrdersController and PublicReviewsController
 * live in this module (not separate ones) for the same reason
 * catalog-service keeps SellerProductsController alongside its public
 * controller — Fase B (avaliação e reputação, ver
 * roadmap-mercado-livre.md) does not justify its own module: it is a
 * small, closely related concern owned by the same Prisma schema.
 */
@Module({
  imports: [PaymentsModule],
  controllers: [OrdersController, SellerOrdersController, PublicReviewsController],
  providers: [OrdersService, ReviewsService],
})
export class OrdersModule {}
