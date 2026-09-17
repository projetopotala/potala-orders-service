import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AppConfig } from './config/configuration';
import { API_GLOBAL_PREFIX } from './common/constants/auth.constants';
import { GlobalExceptionFilter } from './common/filters/http-exception.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get(ConfigService<AppConfig, true>);
  const logger = new Logger('Bootstrap');

  app.set('trust proxy', 1);
  app.setGlobalPrefix(API_GLOBAL_PREFIX);

  // Lets process signals such as SIGTERM/SIGINT trigger the Nest shutdown
  // lifecycle, so PrismaService.onModuleDestroy closes the pool when the
  // platform recycles the container. The lifecycle also runs on an explicit
  // app.close(); what the hooks add is the trigger by signal.
  app.enableShutdownHooks();

  app.use(helmet());
  app.use(cookieParser());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new GlobalExceptionFilter());

  app.enableCors({
    origin: config.get('frontendUrl', { infer: true }),
    credentials: true,
  });

  if (config.get('swaggerEnabled', { infer: true })) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Marketplace Potala — orders-service')
        .setDescription(
          'Checkout multi-vendedor, pedidos e pagamento (simulado nesta v1). Autenticação via cookie HttpOnly (introspectado em identity-service). Prefixo global /api/v1. Este serviço não expõe rotas /internal/* próprias — é apenas cliente de identity-service e catalog-service.',
        )
        .setVersion('0.1.0')
        .addServer('/', 'Current host')
        .build(),
    );
    SwaggerModule.setup(`${API_GLOBAL_PREFIX}/docs`, app, document, {
      swaggerOptions: { persistAuthorization: false },
    });
    logger.log(`Swagger available at /${API_GLOBAL_PREFIX}/docs`);
  }

  const port = config.get('port', { infer: true });
  await app.listen(port, '0.0.0.0');
  logger.log(`orders-service listening on 0.0.0.0:${port}`);
}

void bootstrap();
