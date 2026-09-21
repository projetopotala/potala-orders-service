import { Global, Module } from '@nestjs/common';
import { CatalogServiceClient } from './catalog-service.client';
import { IdentityServiceClient } from './identity-service.client';
import { SellersServiceClient } from './sellers-service.client';

/**
 * Global, like PrismaModule: both clients are needed app-wide (SessionAuthGuard
 * via APP_GUARD in app.module.ts, OrdersService for checkout) — simplest to
 * provide them once at the root, same reasoning the other services' own
 * ClientsModule uses.
 */
@Global()
@Module({
  providers: [IdentityServiceClient, CatalogServiceClient, SellersServiceClient],
  exports: [IdentityServiceClient, CatalogServiceClient, SellersServiceClient],
})
export class ClientsModule {}
