import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Role } from '../../common/types/identity-enums';
import { AuthenticatedUser } from '../../common/types/authenticated-user';
import { OrdersController } from './orders.controller';
import { CustomerClaimsController } from './customer-claims.controller';
import { SellerOrdersController } from './seller-orders.controller';
import { SellerReturnsController } from './seller-returns.controller';
import { SellerClaimsController } from './seller-claims.controller';
import { AdminOrdersController } from './admin-orders.controller';
import { AdminReturnsController } from './admin-returns.controller';
import { AdminClaimsController } from './admin-claims.controller';
import { OrdersService } from './orders.service';
import { ReviewsService } from './reviews.service';
import { ReturnsService } from './returns.service';
import { CouponsService } from './coupons.service';
import { FavoritesService } from './favorites.service';
import { CreateCheckoutDto } from './dto/create-checkout.dto';

/**
 * Vendedor também compra com a mesma conta. identity-service entrega a um
 * vendedor SOMENTE a role SELLER (nunca CUSTOMER), então as rotas de
 * comprador precisam aceitar CUSTOMER *ou* SELLER -- sem abrir nenhuma rota
 * de admin/vendedor para quem só é cliente, e sem alterar o RolesGuard
 * global. Estes testes usam o RolesGuard REAL lendo o metadata @Roles real
 * de cada controller.
 */

const USER_ID = '00000000-0000-4000-8000-0000000b0001';
const OTHER_ORDER_ID = '00000000-0000-4000-8000-0000000b0002';

function userWith(...roles: Role[]): AuthenticatedUser {
  return {
    id: USER_ID,
    email: 'u@test.com',
    status: 'ACTIVE' as AuthenticatedUser['status'],
    roles,
  };
}

function canCall(
  controller: new (...args: never[]) => unknown,
  handlerName: string,
  user: AuthenticatedUser,
): boolean {
  const guard = new RolesGuard(new Reflector());
  const handler = (controller.prototype as Record<string, () => unknown>)[
    handlerName
  ];
  const context = {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => ({ authUser: user }) }),
  } as unknown as ExecutionContext;
  try {
    return guard.canActivate(context);
  } catch (err) {
    if (err instanceof ForbiddenException) return false;
    throw err;
  }
}

describe('rotas de comprador aceitam CUSTOMER ou SELLER (RolesGuard real)', () => {
  const buyerRoutes: Array<
    [string, new (...args: never[]) => unknown, string]
  > = [
    ['POST /orders/checkout', OrdersController, 'checkout'],
    ['GET /orders', OrdersController, 'list'],
    ['GET /orders/:id', OrdersController, 'getOne'],
    ['GET /orders/returns', OrdersController, 'listReturns'],
    ['GET /orders/reviews', OrdersController, 'listReviews'],
    ['GET /orders/coupons', OrdersController, 'listCoupons'],
    ['GET /orders/favorites', OrdersController, 'listFavorites'],
    ['POST /orders/favorites', OrdersController, 'addFavorite'],
    ['POST review', OrdersController, 'createReview'],
    ['POST return', OrdersController, 'createReturn'],
    ['GET /orders/claims', CustomerClaimsController, 'list'],
  ];

  it.each(buyerRoutes)('%s: CUSTOMER continua autorizado', (_n, ctrl, h) => {
    expect(canCall(ctrl, h, userWith(Role.CUSTOMER))).toBe(true);
  });

  it.each(buyerRoutes)(
    '%s: usuário com SOMENTE a role SELLER está autorizado',
    (_n, ctrl, h) => {
      expect(canCall(ctrl, h, userWith(Role.SELLER))).toBe(true);
    },
  );

  it.each(buyerRoutes)(
    '%s: ADMIN (sem CUSTOMER/SELLER) continua sem acesso de comprador',
    (_n, ctrl, h) => {
      expect(canCall(ctrl, h, userWith(Role.ADMIN))).toBe(false);
    },
  );

  it.each(buyerRoutes)('%s: sem nenhuma role é negado', (_n, ctrl, h) => {
    expect(canCall(ctrl, h, userWith())).toBe(false);
  });
});

describe('cliente comum não ganha permissão de vendedor/admin', () => {
  const restricted: Array<[string, new (...args: never[]) => unknown, string]> =
    [
      ['GET /seller/orders', SellerOrdersController, 'list'],
      ['GET /seller/returns', SellerReturnsController, 'list'],
      ['GET /seller/claims', SellerClaimsController, 'list'],
      ['GET /admin/orders', AdminOrdersController, 'list'],
      ['GET /admin/returns', AdminReturnsController, 'list'],
      ['GET /admin/claims', AdminClaimsController, 'list'],
    ];

  it.each(restricted)('%s: CUSTOMER é negado', (_n, ctrl, h) => {
    expect(canCall(ctrl, h, userWith(Role.CUSTOMER))).toBe(false);
  });

  it.each(restricted.filter(([n]) => n.includes('/admin/')))(
    '%s: SELLER é negado (admin continua exclusivo)',
    (_n, ctrl, h) => {
      expect(canCall(ctrl, h, userWith(Role.SELLER))).toBe(false);
    },
  );

  it.each(restricted.filter(([n]) => n.includes('/seller/')))(
    '%s: SELLER continua autorizado (rotas de loja inalteradas)',
    (_n, ctrl, h) => {
      expect(canCall(ctrl, h, userWith(Role.SELLER))).toBe(true);
    },
  );
});

describe('OrdersController com usuário SELLER: comprador = authUser.id', () => {
  function build() {
    const ordersService = {
      checkout: jest.fn().mockResolvedValue({ id: 'order-1' }),
      listForCustomer: jest.fn().mockResolvedValue({ items: [] }),
      getForCustomer: jest.fn().mockResolvedValue({ id: OTHER_ORDER_ID }),
    } as unknown as jest.Mocked<OrdersService>;
    const returnsService = {
      listForCustomer: jest.fn(),
    } as unknown as jest.Mocked<ReturnsService>;
    const reviewsService = {
      listForCustomer: jest.fn(),
    } as unknown as jest.Mocked<ReviewsService>;
    const favoritesService = {
      listForCustomer: jest.fn(),
    } as unknown as jest.Mocked<FavoritesService>;
    const couponsService = {} as unknown as jest.Mocked<CouponsService>;
    const controller = new OrdersController(
      ordersService,
      reviewsService,
      returnsService,
      couponsService,
      favoritesService,
    );
    return {
      controller,
      ordersService,
      returnsService,
      reviewsService,
      favoritesService,
    };
  }

  const seller = userWith(Role.SELLER);

  it('checkout cria o pedido com a identidade da sessão, ignorando customerId vindo do body', async () => {
    const { controller, ordersService } = build();
    const dto = {
      items: [],
      shippingAddress: {},
      customerId: '00000000-0000-4000-8000-0000000bad01',
    } as unknown as CreateCheckoutDto;
    await controller.checkout(seller, dto);
    expect(ordersService.checkout).toHaveBeenCalledTimes(1);
    expect(ordersService.checkout.mock.calls[0][0]).toBe(USER_ID);
  });

  it('list/getOne/returns/reviews/favorites escopam sempre por authUser.id', async () => {
    const {
      controller,
      ordersService,
      returnsService,
      reviewsService,
      favoritesService,
    } = build();
    await controller.list(seller, {});
    await controller.getOne(seller, OTHER_ORDER_ID);
    await controller.listReturns(seller, {});
    await controller.listReviews(seller, {});
    await controller.listFavorites(seller, {});
    expect(ordersService.listForCustomer).toHaveBeenCalledWith(USER_ID, {});
    expect(ordersService.getForCustomer).toHaveBeenCalledWith(
      USER_ID,
      OTHER_ORDER_ID,
    );
    expect(returnsService.listForCustomer).toHaveBeenCalledWith(USER_ID, {});
    expect(reviewsService.listForCustomer).toHaveBeenCalledWith(USER_ID, {});
    expect(favoritesService.listForCustomer).toHaveBeenCalledWith(USER_ID, {});
  });
});
