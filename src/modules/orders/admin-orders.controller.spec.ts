import { AdminOrdersController } from './admin-orders.controller';
import { OrdersService } from './orders.service';
import { Role } from '../../common/types/identity-enums';
import { AuthenticatedUser } from '../../common/types/authenticated-user';

const ADMIN_USER: AuthenticatedUser = {
  id: '00000000-0000-4000-8000-000000003001',
  email: 'admin@test.com',
  status: 'ACTIVE' as AuthenticatedUser['status'],
  roles: [Role.ADMIN],
};
const SELLER_ORDER_ID = '00000000-0000-4000-8000-000000003002';

describe('AdminOrdersController', () => {
  function build() {
    const ordersService = {
      listForAdmin: jest.fn(),
      prepareForAdmin: jest.fn(),
      shipForAdmin: jest.fn(),
      deliverForAdmin: jest.fn(),
    } as unknown as jest.Mocked<OrdersService>;
    return { controller: new AdminOrdersController(ordersService), ordersService };
  }

  it('delegates each fulfillment transition with the authenticated admin id', async () => {
    const { controller, ordersService } = build();
    await controller.prepare(ADMIN_USER, SELLER_ORDER_ID);
    await controller.ship(ADMIN_USER, SELLER_ORDER_ID);
    await controller.deliver(ADMIN_USER, SELLER_ORDER_ID);

    expect(ordersService.prepareForAdmin).toHaveBeenCalledWith(
      SELLER_ORDER_ID,
      ADMIN_USER.id,
    );
    expect(ordersService.shipForAdmin).toHaveBeenCalledWith(
      SELLER_ORDER_ID,
      ADMIN_USER.id,
    );
    expect(ordersService.deliverForAdmin).toHaveBeenCalledWith(
      SELLER_ORDER_ID,
      ADMIN_USER.id,
    );
  });
});
