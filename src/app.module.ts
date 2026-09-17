import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppConfig } from './config/configuration';
import { validateEnv } from './config/env.validation';
import { PrismaModule } from './database/prisma.module';
import { ClientsModule } from './clients/clients.module';
import { SessionAuthGuard } from './common/guards/session.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { OriginGuard } from './common/guards/origin.guard';
import { RequestLoggingInterceptor } from './common/interceptors/request-logging.interceptor';
import { OrdersModule } from './modules/orders/orders.module';
import { HealthModule } from './modules/health/health.module';

/**
 * Single throttle group, unlike catalog-service's or identity-service's own
 * app.module.ts: this service exposes no /internal/* routes and no /auth/*
 * routes of its own in this v1 (see auth.constants.ts and
 * docs/internal-api-contract.md), so there is nothing to split the default
 * throttle group against — every route here goes through the same limit.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: ['.env'],
      validate: validateEnv,
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => {
        const throttle = config.get('throttle', { infer: true });
        return {
          throttlers: [
            {
              name: 'default',
              ttl: throttle.ttlMs,
              limit: throttle.limit,
            },
          ],
        };
      },
    }),
    PrismaModule,
    ClientsModule,
    OrdersModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: OriginGuard },
    { provide: APP_GUARD, useClass: SessionAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_INTERCEPTOR, useClass: RequestLoggingInterceptor },
  ],
})
export class AppModule {}
