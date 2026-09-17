import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { PaymentsModule } from '../payments/payments.module';

/**
 * ClientsModule (CatalogServiceClient) and PrismaModule are both @Global(),
 * so neither is imported here explicitly — same pattern every other
 * feature module in this project follows. PaymentsModule is not global
 * (it is specific to checkout), so it is imported directly.
 */
@Module({
  imports: [PaymentsModule],
  controllers: [OrdersController],
  providers: [OrdersService],
})
export class OrdersModule {}
