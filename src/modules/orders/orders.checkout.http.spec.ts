import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { ReviewsService } from './reviews.service';
import { ReturnsService } from './returns.service';
import { CouponsService } from './coupons.service';
import { FavoritesService } from './favorites.service';
import {
  CheckoutIdempotencyInProgressException,
  CheckoutIdempotencyReplayedErrorException,
  CheckoutIdempotencyService,
} from './checkout-idempotency.service';
import { IdentityServiceClient } from '../../clients/identity-service.client';
import { SessionAuthGuard } from '../../common/guards/session.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { GlobalExceptionFilter } from '../../common/filters/http-exception.filter';
import { Role } from '../../common/types/identity-enums';

/**
 * F2.1 -- POST /api/v1/orders/checkout em HTTP real (supertest), com os
 * guards REAIS de produção (SessionAuthGuard + RolesGuard; só a
 * introspecção no identity-service é simulada), o ValidationPipe e o filtro
 * global de main.ts. OrdersService é simulado: aqui se prova o contrato
 * HTTP do header Idempotency-Key e a compatibilidade com a autenticação; a
 * lógica de idempotência é coberta em checkout-idempotency.service.spec.ts e
 * orders.checkout-idempotency.spec.ts.
 */
const CUSTOMER_ID = '00000000-0000-4000-8000-000000000c01';
const SELLER_ID = '00000000-0000-4000-8000-000000000c02';
const PRODUCT = '00000000-0000-4000-8000-00000000a001';
const VARIANT = '00000000-0000-4000-8000-00000000a002';
const KEY = '11111111-1111-4111-8111-111111111111';

const SESSIONS: Record<string, unknown> = {
  cliente: {
    id: CUSTOMER_ID,
    email: 'cliente@exemplo.test',
    status: 'ACTIVE',
    roles: [Role.CUSTOMER],
  },
  vendedor: {
    id: SELLER_ID,
    email: 'vendedor@exemplo.test',
    status: 'ACTIVE',
    roles: [Role.SELLER],
  },
  admin: {
    id: SELLER_ID,
    email: 'admin@exemplo.test',
    status: 'ACTIVE',
    roles: [Role.ADMIN],
  },
};

const BODY = {
  items: [{ productId: PRODUCT, variantId: VARIANT, quantity: 1 }],
  shippingAddress: {
    recipient: 'Maria Silva',
    street: 'Rua das Flores',
    number: '123',
    neighborhood: 'Centro',
    city: 'São Paulo',
    state: 'SP',
    postalCode: '01310-000',
  },
};

const ORDER = { id: 'order-1', orderNumber: 'PED-TESTE-1', status: 'PAID' };

describe('POST /orders/checkout -- F2.1 Idempotency-Key over HTTP with the real auth guards', () => {
  let app: INestApplication;
  const checkoutWithOptionalKey = jest.fn();
  const parseKey = new CheckoutIdempotencyService(null as never);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [OrdersController],
      providers: [
        { provide: OrdersService, useValue: { checkoutWithOptionalKey } },
        { provide: ReviewsService, useValue: {} },
        { provide: ReturnsService, useValue: {} },
        { provide: CouponsService, useValue: {} },
        { provide: FavoritesService, useValue: {} },
        {
          provide: IdentityServiceClient,
          useValue: {
            introspectSession: jest.fn(
              async (token: string) => SESSIONS[token] ?? null,
            ),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              ({ session: { cookieName: 'potala_session' } })[key],
          },
        },
        { provide: APP_GUARD, useClass: SessionAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    checkoutWithOptionalKey.mockReset();
    checkoutWithOptionalKey.mockImplementation(
      async (_user: string, _dto: unknown, key: unknown) => {
        parseKey.parseKey(key);
        return { order: ORDER, replayed: false };
      },
    );
  });

  const post = (session?: string) => {
    const req = request(app.getHttpServer()).post('/api/v1/orders/checkout');
    return session ? req.set('Cookie', `potala_session=${session}`) : req;
  };

  it('without a session: 401 and the service is never called (key or not)', async () => {
    await post().set('Idempotency-Key', KEY).send(BODY).expect(401);
    expect(checkoutWithOptionalKey).not.toHaveBeenCalled();
  });

  // F2.3 -- integrado com a D-16 (vendedor tambem compra): a rota de
  // checkout passou a aceitar CUSTOMER ou SELLER. ADMIN continua 403.
  it('admin session: 403, service never called', async () => {
    await post('admin').set('Idempotency-Key', KEY).send(BODY).expect(403);
    expect(checkoutWithOptionalKey).not.toHaveBeenCalled();
  });

  it('vendedor session (D-16): 201, buyer = session user, key forwarded', async () => {
    const response = await post('vendedor')
      .set('Idempotency-Key', KEY)
      .send(BODY)
      .expect(201);
    expect(response.body).toEqual(ORDER);
    expect(checkoutWithOptionalKey).toHaveBeenCalledTimes(1);
    expect(checkoutWithOptionalKey).toHaveBeenCalledWith(
      SELLER_ID,
      expect.objectContaining({ items: BODY.items }),
      KEY,
    );
  });

  it('customer without the header: legacy path (service receives no key), 201', async () => {
    const response = await post('cliente').send(BODY).expect(201);
    expect(response.body).toEqual(ORDER);
    expect(response.headers['idempotent-replayed']).toBeUndefined();
    expect(checkoutWithOptionalKey).toHaveBeenCalledWith(
      CUSTOMER_ID,
      expect.objectContaining({ items: BODY.items }),
      undefined,
    );
  });

  it('customer with the header: the key and the AUTHENTICATED user id reach the service (case-insensitive header)', async () => {
    await post('cliente').set('idempotency-key', KEY).send(BODY).expect(201);
    expect(checkoutWithOptionalKey).toHaveBeenCalledWith(
      CUSTOMER_ID,
      expect.anything(),
      KEY,
    );
  });

  it('a user id in the body is rejected by the ValidationPipe -- the owner of the key is always the session', async () => {
    await post('cliente')
      .set('Idempotency-Key', KEY)
      .send({ ...BODY, customerId: SELLER_ID })
      .expect(400);
    expect(checkoutWithOptionalKey).not.toHaveBeenCalled();
  });

  it('replayed success: 201 with the same order and Idempotent-Replayed: true', async () => {
    checkoutWithOptionalKey.mockResolvedValue({ order: ORDER, replayed: true });
    const response = await post('cliente')
      .set('Idempotency-Key', KEY)
      .send(BODY)
      .expect(201);
    expect(response.body).toEqual(ORDER);
    expect(response.headers['idempotent-replayed']).toBe('true');
  });

  it('replayed stored error: same status and body, marked Idempotent-Replayed: true', async () => {
    checkoutWithOptionalKey.mockRejectedValue(
      new CheckoutIdempotencyReplayedErrorException(
        {
          statusCode: 503,
          message: 'Payment gateway is unavailable. Try again shortly.',
          error: 'Service Unavailable',
        },
        503,
      ),
    );
    const response = await post('cliente')
      .set('Idempotency-Key', KEY)
      .send(BODY)
      .expect(503);
    expect(response.body.message).toBe(
      'Payment gateway is unavailable. Try again shortly.',
    );
    expect(response.headers['idempotent-replayed']).toBe('true');
  });

  it('a first-time error is NOT marked as replayed', async () => {
    checkoutWithOptionalKey.mockRejectedValue(
      new CheckoutIdempotencyInProgressException(),
    );
    const response = await post('cliente')
      .set('Idempotency-Key', KEY)
      .send(BODY)
      .expect(409);
    expect(response.headers['idempotent-replayed']).toBeUndefined();
  });

  it.each([
    ['too short', 'abc'],
    ['spaces', 'chave com espaços 1234567'],
    ['two values joined by the proxy', `${KEY}, ${KEY}`],
  ])('invalid header (%s): 400', async (_label, value) => {
    await post('cliente').set('Idempotency-Key', value).send(BODY).expect(400);
  });
});
