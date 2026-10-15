import {
  INestApplication,
  Logger,
  ServiceUnavailableException,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { SessionAuthGuard } from '../guards/session.guard';
import { RolesGuard } from '../guards/roles.guard';
import { IdentityServiceClient } from '../../clients/identity-service.client';
import { SellersServiceClient } from '../../clients/sellers-service.client';
import { Role, UserStatus } from '../types/identity-enums';
import { PermissionShadowInterceptor } from './permission-shadow.interceptor';
import { AdminOrdersController } from '../../modules/orders/admin-orders.controller';
import { AdminReturnsController } from '../../modules/orders/admin-returns.controller';
import { AdminCouponsController } from '../../modules/orders/admin-coupons.controller';
import { OrdersController } from '../../modules/orders/orders.controller';
import { SellerOrdersController } from '../../modules/orders/seller-orders.controller';
import { OrdersService } from '../../modules/orders/orders.service';
import { ReturnsService } from '../../modules/orders/returns.service';
import { CouponsService } from '../../modules/orders/coupons.service';
import { ReviewsService } from '../../modules/orders/reviews.service';
import { FavoritesService } from '../../modules/orders/favorites.service';

/**
 * F1.3 -- teste de integração de componentes (HTTP em memória, sem banco e
 * sem rede): SessionAuthGuard, RolesGuard e SellerContextGuard REAIS +
 * controllers reais + PermissionShadowInterceptor, com a introspecção, o
 * sellers-service e os serviços de domínio substituídos. Prova que o modo
 * sombra não muda nenhum status HTTP nem corpo de resposta, e não acrescenta
 * chamadas de introspecção.
 */
const SELLER_A = '0a000000-0000-4000-8000-00000000000a';
const GRANT_ID = '10000000-0000-4000-8000-000000000001';

const base = { email: 'pessoa@exemplo.test', status: UserStatus.ACTIVE };
const grant = (overrides: Record<string, unknown> = {}) => ({
  grantId: GRANT_ID,
  roleId: '30000000-0000-4000-8000-000000000003',
  roleKey: 'OPERATIONS',
  permissions: ['orders:order:read', 'aftersales:return:approve'],
  scope: { type: 'GLOBAL', sellerIds: [] },
  expiresAt: null,
  ...overrides,
});

const USERS: Record<string, Record<string, unknown>> = {
  'admin-legado': { id: 'u-admin-legado', ...base, roles: [Role.ADMIN] },
  'admin-com-grant': {
    id: 'u-admin-1',
    ...base,
    roles: [Role.ADMIN],
    isSuperAdmin: false,
    grants: [grant()],
  },
  'admin-sem-grant': {
    id: 'u-admin-2',
    ...base,
    roles: [Role.ADMIN],
    isSuperAdmin: false,
    grants: [],
  },
  'admin-grant-expirado': {
    id: 'u-admin-3',
    ...base,
    roles: [Role.ADMIN],
    isSuperAdmin: false,
    grants: [grant({ expiresAt: '2000-01-01T00:00:00.000Z' })],
  },
  'admin-sellers-a': {
    id: 'u-admin-4',
    ...base,
    roles: [Role.ADMIN],
    isSuperAdmin: false,
    grants: [grant({ scope: { type: 'SELLERS', sellerIds: [SELLER_A] } })],
  },
  superadmin: {
    id: 'u-super',
    ...base,
    roles: [Role.ADMIN],
    isSuperAdmin: true,
    grants: [],
  },
  cliente: {
    id: 'u-cliente',
    ...base,
    roles: [Role.CUSTOMER],
    isSuperAdmin: false,
    grants: [grant()],
  },
  vendedor: {
    id: 'u-vendedor',
    ...base,
    roles: [Role.SELLER],
    isSuperAdmin: true,
    grants: [grant()],
  },
  'vendedor-comprador': {
    id: 'u-vc',
    ...base,
    roles: [Role.CUSTOMER, Role.SELLER],
    isSuperAdmin: false,
    grants: [grant()],
  },
};

const LIST_RESULT = {
  items: [{ id: 'r-1' }],
  pageInfo: { hasNextPage: false, nextCursor: null },
};

function anyService(result: unknown) {
  return new Proxy(
    {},
    {
      get: (_target, prop) =>
        typeof prop === 'string' && prop !== 'then' && !prop.startsWith('on')
          ? jest.fn().mockResolvedValue(result)
          : undefined,
    },
  );
}

async function buildApp(shadow: boolean) {
  const identity = {
    introspectSession: jest.fn(async (token: string) => {
      if (token === 'identity-fora') {
        throw new ServiceUnavailableException(
          'Authentication service is unavailable. Try again shortly.',
        );
      }
      return USERS[token] ?? null;
    }),
  };
  const sellersClient = {
    getMembershipByUserId: jest.fn(async (userId: string) =>
      userId === 'u-vendedor' || userId === 'u-vc'
        ? {
            membershipId: 'm-1',
            userId,
            sellerId: SELLER_A,
            membershipRole: 'OWNER',
            sellerStatus: 'ACTIVE',
          }
        : null,
    ),
  };
  const moduleRef = await Test.createTestingModule({
    controllers: [
      AdminOrdersController,
      AdminReturnsController,
      AdminCouponsController,
      OrdersController,
      SellerOrdersController,
    ],
    providers: [
      { provide: OrdersService, useValue: anyService(LIST_RESULT) },
      { provide: ReturnsService, useValue: anyService(LIST_RESULT) },
      { provide: CouponsService, useValue: anyService(LIST_RESULT) },
      { provide: ReviewsService, useValue: anyService(LIST_RESULT) },
      { provide: FavoritesService, useValue: anyService(LIST_RESULT) },
      { provide: SellersServiceClient, useValue: sellersClient },
      { provide: IdentityServiceClient, useValue: identity },
      {
        provide: ConfigService,
        useValue: {
          get: (key: string) =>
            ({
              session: { cookieName: 'potala_session' },
              permissionShadow: { enabled: shadow },
            })[key],
        },
      },
      { provide: APP_GUARD, useClass: SessionAuthGuard },
      { provide: APP_GUARD, useClass: RolesGuard },
      { provide: APP_INTERCEPTOR, useClass: PermissionShadowInterceptor },
    ],
  }).compile();
  const app: INestApplication = moduleRef.createNestApplication({
    logger: false,
  });
  app.setGlobalPrefix('api/v1');
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.init();
  return { app, identity };
}

function shadowLines(spy: jest.SpyInstance): Array<Record<string, unknown>> {
  return spy.mock.calls
    .map(([line]) => line)
    .filter(
      (line): line is string =>
        typeof line === 'string' && line.includes('"permission_shadow"'),
    )
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('F1.3 -- modo sombra com os guards reais (orders-service)', () => {
  let log: jest.SpyInstance;
  beforeEach(() => {
    log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  describe.each([false, true])('PERMISSION_SHADOW_MODE=%p', (shadow) => {
    let app: INestApplication;
    let identity: { introspectSession: jest.Mock };
    beforeAll(async () => {
      ({ app, identity } = await buildApp(shadow));
    });
    afterAll(async () => app.close());
    beforeEach(() => identity.introspectSession.mockClear());

    const get = (path: string, token?: string) => {
      const req = request(app.getHttpServer()).get(path);
      return token ? req.set('Cookie', `potala_session=${token}`) : req;
    };
    const patch = (path: string, token: string) =>
      request(app.getHttpServer())
        .patch(path)
        .set('Cookie', `potala_session=${token}`)
        .send({});

    it('sem sessão -> 401 (preservado), sem decisão sombra', async () => {
      await get('/api/v1/admin/orders').expect(401);
      expect(shadowLines(log)).toEqual([]);
    });

    it('sessão inválida -> 401; identity indisponível -> 503 (preservados)', async () => {
      await get('/api/v1/admin/orders', 'token-desconhecido').expect(401);
      await get('/api/v1/admin/orders', 'identity-fora').expect(503);
      expect(shadowLines(log)).toEqual([]);
    });

    it.each(['cliente', 'vendedor', 'vendedor-comprador'])(
      '%s (mesmo com concessões forjadas na introspecção) -> 403 nas rotas administrativas, sem decisão sombra',
      async (token) => {
        await get('/api/v1/admin/orders', token).expect(403);
        expect(shadowLines(log)).toEqual([]);
      },
    );

    it.each([
      ['admin-legado', 'NOT_EVALUATED', 'LEGACY_INTROSPECTION'],
      ['admin-com-grant', 'WOULD_ALLOW', 'GRANT_COVERS'],
      ['admin-sem-grant', 'WOULD_DENY', 'PERMISSION_MISSING'],
      ['admin-grant-expirado', 'WOULD_DENY', 'GRANT_EXPIRED'],
      ['admin-sellers-a', 'WOULD_ALLOW', 'SCOPE_FILTER_REQUIRED'],
      ['superadmin', 'WOULD_ALLOW', 'SUPERADMIN'],
    ])(
      '%s -> 200 com a mesma resposta; decisão sombra %s/%s só com a flag ligada',
      async (token, outcome, reason) => {
        const response = await get('/api/v1/admin/orders', token).expect(200);
        expect(response.body).toEqual(LIST_RESULT);
        expect(identity.introspectSession).toHaveBeenCalledTimes(1);
        const lines = shadowLines(log);
        if (!shadow) {
          expect(lines).toEqual([]);
          return;
        }
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatchObject({
          service: 'orders-service',
          method: 'GET',
          route: '/api/v1/admin/orders',
          permission: 'orders:order:read',
          scopeMode: 'COLLECTION',
          outcome,
          reason,
        });
      },
    );

    it('devolução (recurso de vendedor) com escopo SELLERS -> 200; sombra NOT_EVALUATED', async () => {
      await patch(
        '/api/v1/admin/returns/0d000000-0000-4000-8000-00000000000d/approve',
        'admin-sellers-a',
      ).expect(200);
      const lines = shadowLines(log);
      if (shadow) {
        expect(lines[0]).toMatchObject({
          permission: 'aftersales:return:approve',
          scopeMode: 'SELLER_OWNED',
          outcome: 'NOT_EVALUATED',
          reason: 'RESOURCE_SELLER_UNRESOLVED',
        });
      } else {
        expect(lines).toEqual([]);
      }
    });

    it('cupons da plataforma: ADMIN com permissão GLOBAL -> WOULD_ALLOW; sem a permissão -> WOULD_DENY; ambos 200', async () => {
      await get('/api/v1/admin/coupons', 'superadmin').expect(200);
      await get('/api/v1/admin/coupons', 'admin-com-grant').expect(200);
      const lines = shadowLines(log);
      if (shadow) {
        expect(lines.map((line) => [line.permission, line.outcome])).toEqual([
          ['marketing:coupon:read', 'WOULD_ALLOW'],
          ['marketing:coupon:read', 'WOULD_DENY'],
        ]);
      } else {
        expect(lines).toEqual([]);
      }
    });

    it('regressão "vendedor também compra": SELLER e CUSTOMER+SELLER seguem 200 nas rotas de comprador, sem decisão sombra', async () => {
      await get('/api/v1/orders', 'vendedor').expect(200);
      await get('/api/v1/orders', 'vendedor-comprador').expect(200);
      await get('/api/v1/orders', 'cliente').expect(200);
      await get('/api/v1/orders', 'admin-com-grant').expect(403);
      await get('/api/v1/orders', 'superadmin').expect(403);
      expect(shadowLines(log)).toEqual([]);
    });

    it('rota da loja: vendedor segue 200 (isolado pela própria loja), ADMIN segue 403; nenhuma decisão sombra', async () => {
      await get('/api/v1/seller/orders', 'vendedor').expect(200);
      await get('/api/v1/seller/orders', 'admin-com-grant').expect(403);
      expect(shadowLines(log)).toEqual([]);
    });
  });
});
