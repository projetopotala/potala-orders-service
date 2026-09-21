import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { SellerOrdersController } from './seller-orders.controller';
import { OrdersService } from './orders.service';
import { PaymentsModule } from '../payments/payments.module';

/**
 * ClientsModule (CatalogServiceClient, SellersServiceClient) and
 * PrismaModule are both @Global(), so neither is imported here explicitly
 * — same pattern every other feature module in this project follows.
 * PaymentsModule is not global (it is specific to checkout), so it is
 * imported directly. SellerOrdersController lives in this module (not a
 * separate one) for the same reason catalog-service keeps
 * SellerProductsController alongside its public controller.
 */
@Module({
  imports: [PaymentsModule],
  controllers: [OrdersController, SellerOrdersController],
  providers: [OrdersService],
})
export class OrdersModule {}
