import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { OrdersService } from './orders.service';
import { CheckoutIdempotencyService } from './checkout-idempotency.service';
import {
  createCatalogServiceClientMock,
  createCouponsServiceMock,
  createPaymentGatewayClientMock,
  createPrismaMock,
} from '../../test-utils/prisma.mock';
import { INT4_MAX, MAX_ORDER_NUMBER_RETRIES } from '../../common/constants/orders.constants';
import { CreateCheckoutDto } from './dto/create-checkout.dto';

const CUSTOMER_ID = '00000000-0000-4000-8000-000000000c01';
const PRODUCT_A = '00000000-0000-4000-8000-00000000a001';
const VARIANT_A = '00000000-0000-4000-8000-00000000a002';
const SELLER_A = '00000000-0000-4000-8000-00000000a003';
const PRODUCT_B = '00000000-0000-4000-8000-00000000b001';
const VARIANT_B = '00000000-0000-4000-8000-00000000b002';
const SELLER_B = '00000000-0000-4000-8000-00000000b003';

function shippingAddress() {
  return {
    recipient: 'Maria Silva',
    street: 'Rua das Flores',
    number: '123',
    neighborhood: 'Centro',
    city: 'São Paulo',
    state: 'SP',
    postalCode: '01310-000',
  };
}

function resolvedVariant(overrides: Record<string, unknown> = {}) {
  return {
    variantId: VARIANT_A,
    productId: PRODUCT_A,
    sellerId: SELLER_A,
    productStatus: 'ACTIVE',
    productTitle: 'Produto A',
    sku: 'SKU-A',
    variantName: 'Padrão',
    unitPriceCents: 1000,
    availableQuantity: 10,
    ...overrides,
  };
}

function checkoutDto(overrides: Partial<CreateCheckoutDto> = {}): CreateCheckoutDto {
  return {
    items: [{ productId: PRODUCT_A, variantId: VARIANT_A, quantity: 2 }],
    shippingAddress: shippingAddress(),
    ...overrides,
  } as CreateCheckoutDto;
}

/** Wires up the minimum every happy-path test needs; individual tests override what they care about. */
function setUpHappyPath() {
  const prisma = createPrismaMock();
  const catalogServiceClient = createCatalogServiceClientMock();
  const paymentGateway = createPaymentGatewayClientMock();
  const couponsService = createCouponsServiceMock();

  catalogServiceClient.resolveVariants.mockResolvedValue([resolvedVariant()]);
  catalogServiceClient.reserveInventory.mockResolvedValue(undefined);
  catalogServiceClient.commitInventory.mockResolvedValue(undefined);
  catalogServiceClient.releaseInventory.mockResolvedValue(undefined);
  prisma.order.create.mockResolvedValue({
    id: 'order-1',
    orderNumber: 'PED-TEST-1',
    customerId: CUSTOMER_ID,
  });
  prisma.sellerOrder.create.mockResolvedValue({ id: 'seller-order-1' });
  // F2.2A -- subpedidos do pedido no momento da finalização/cancelamento.
  prisma.sellerOrder.findMany.mockResolvedValue([
    { id: 'seller-order-1', sellerId: SELLER_A, status: 'PENDING' },
  ]);
  prisma.orderItem.create.mockResolvedValue({ id: 'order-item-1' });
  prisma.paymentTransaction.create.mockResolvedValue({ id: 'payment-1' });
  prisma.order.findFirst.mockResolvedValue({
    id: 'order-1',
    orderNumber: 'PED-TEST-1',
    customerId: CUSTOMER_ID,
  });
  paymentGateway.charge.mockResolvedValue({
    status: 'APPROVED',
    provider: 'mock',
    providerRef: 'mock_ref_1',
  });

  const service = new OrdersService(
    prisma as never,
    catalogServiceClient as never,
    paymentGateway as never,
    couponsService as never,
    new CheckoutIdempotencyService(prisma as never),
  );

  return { service, prisma, catalogServiceClient, paymentGateway, couponsService };
}

function uniqueOrderNumberViolation() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '6.15.0',
    meta: { target: ['numero_pedido'] },
  });
}

describe('OrdersService', () => {
  describe('checkout — happy path', () => {
    it('resolves cart items against catalog-service and never trusts client-supplied price/seller', async () => {
      const { service, catalogServiceClient } = setUpHappyPath();

      await service.checkout(CUSTOMER_ID, checkoutDto());

      expect(catalogServiceClient.resolveVariants).toHaveBeenCalledWith([VARIANT_A]);
    });

    it('groups items by seller and computes correct subtotal/total', async () => {
      const { service, catalogServiceClient, prisma } = setUpHappyPath();
      catalogServiceClient.resolveVariants.mockResolvedValue([
        resolvedVariant({ unitPriceCents: 1000 }),
        resolvedVariant({
          variantId: VARIANT_B,
          productId: PRODUCT_B,
          sellerId: SELLER_B,
          unitPriceCents: 2000,
        }),
      ]);

      await service.checkout(
        CUSTOMER_ID,
        checkoutDto({
          items: [
            { productId: PRODUCT_A, variantId: VARIANT_A, quantity: 2 },
            { productId: PRODUCT_B, variantId: VARIANT_B, quantity: 1 },
          ],
        }),
      );

      // 2 * 1000 + 1 * 2000 = 4000
      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            subtotalCents: 4000,
            shippingCents: 0,
            discountCents: 0,
            totalCents: 4000,
          }),
        }),
      );
      // Two distinct sellers -> two SellerOrder rows.
      expect(prisma.sellerOrder.create).toHaveBeenCalledTimes(2);
      expect(prisma.orderItem.create).toHaveBeenCalledTimes(2);
    });

    it('reserves stock for every resolved item after the order is created', async () => {
      const { service, catalogServiceClient } = setUpHappyPath();

      await service.checkout(CUSTOMER_ID, checkoutDto());

      expect(catalogServiceClient.reserveInventory).toHaveBeenCalledWith([
        { variantId: VARIANT_A, quantity: 2 },
      ]);
    });

    it('charges the payment gateway for the computed total and commits stock on approval', async () => {
      const { service, catalogServiceClient, paymentGateway, prisma } =
        setUpHappyPath();

      const result = await service.checkout(CUSTOMER_ID, checkoutDto());

      expect(paymentGateway.charge).toHaveBeenCalledWith({
        orderId: 'order-1',
        orderNumber: 'PED-TEST-1',
        amountCents: 2000,
        splits: [{ sellerId: SELLER_A, amountCents: 2000 }],
      });
      // F2.2A -- cada escrita é condicionada ao status anterior esperado.
      expect(prisma.paymentTransaction.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'payment-1', status: 'PENDING' },
          data: expect.objectContaining({
            status: 'APPROVED',
            provider: 'mock',
            providerRef: 'mock_ref_1',
          }),
        }),
      );
      expect(prisma.order.updateMany).toHaveBeenCalledWith({
        where: { id: 'order-1', status: 'PENDING_PAYMENT' },
        data: { status: 'PAID' },
      });
      expect(prisma.sellerOrder.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'seller-order-1',
          orderId: 'order-1',
          sellerId: SELLER_A,
          status: 'PENDING',
        },
        data: { status: 'CONFIRMED' },
      });
      expect(catalogServiceClient.commitInventory).toHaveBeenCalledWith([
        { variantId: VARIANT_A, quantity: 2 },
      ]);
      expect(result).toEqual(
        expect.objectContaining({ id: 'order-1', orderNumber: 'PED-TEST-1' }),
      );
    });

    it('does not fail checkout when the post-approval commitInventory call itself fails (documented reconciliation gap)', async () => {
      const { service, catalogServiceClient } = setUpHappyPath();
      catalogServiceClient.commitInventory.mockRejectedValue(
        new ServiceUnavailableException(),
      );

      await expect(service.checkout(CUSTOMER_ID, checkoutDto())).resolves.toBeDefined();
    });
  });

  describe('checkout — cart validation against catalog-service', () => {
    it('rejects a variant catalog-service does not return', async () => {
      const { service, catalogServiceClient } = setUpHappyPath();
      catalogServiceClient.resolveVariants.mockResolvedValue([]);

      await expect(
        service.checkout(CUSTOMER_ID, checkoutDto()),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a variant whose resolved productId does not match the request', async () => {
      const { service, catalogServiceClient } = setUpHappyPath();
      catalogServiceClient.resolveVariants.mockResolvedValue([
        resolvedVariant({ productId: PRODUCT_B }),
      ]);

      await expect(
        service.checkout(CUSTOMER_ID, checkoutDto()),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a product that is not ACTIVE', async () => {
      const { service, catalogServiceClient } = setUpHappyPath();
      catalogServiceClient.resolveVariants.mockResolvedValue([
        resolvedVariant({ productStatus: 'INACTIVE' }),
      ]);

      await expect(
        service.checkout(CUSTOMER_ID, checkoutDto()),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects insufficient stock at the early, non-atomic check', async () => {
      const { service, catalogServiceClient, prisma } = setUpHappyPath();
      catalogServiceClient.resolveVariants.mockResolvedValue([
        resolvedVariant({ availableQuantity: 1 }),
      ]);

      await expect(
        service.checkout(CUSTOMER_ID, checkoutDto({ items: [{ productId: PRODUCT_A, variantId: VARIANT_A, quantity: 2 }] })),
      ).rejects.toBeInstanceOf(ConflictException);
      // Never even attempts to create the order for an invalid cart.
      expect(prisma.order.create).not.toHaveBeenCalled();
    });

    it('never creates an order for an invalid cart line', async () => {
      const { service, catalogServiceClient, prisma } = setUpHappyPath();
      catalogServiceClient.resolveVariants.mockResolvedValue([]);

      await expect(service.checkout(CUSTOMER_ID, checkoutDto())).rejects.toThrow();
      expect(prisma.order.create).not.toHaveBeenCalled();
    });
  });

  describe('checkout — inventory reservation failure', () => {
    it('cancels the order and propagates the original error when reserveInventory fails', async () => {
      const { service, catalogServiceClient, prisma } = setUpHappyPath();
      const reserveError = new ConflictException('Insufficient stock for one or more items');
      catalogServiceClient.reserveInventory.mockRejectedValue(reserveError);

      await expect(service.checkout(CUSTOMER_ID, checkoutDto())).rejects.toBe(
        reserveError,
      );
      expect(prisma.order.updateMany).toHaveBeenCalledWith({
        where: { id: 'order-1', status: 'PENDING_PAYMENT' },
        data: { status: 'CANCELLED' },
      });
      // Never reaches the payment step for a reservation that failed.
      expect(prisma.paymentTransaction.create).not.toHaveBeenCalled();
    });
  });

  describe('checkout — payment declined', () => {
    it('releases inventory and cancels the order without throwing when the gateway declines', async () => {
      const { service, catalogServiceClient, paymentGateway, prisma } =
        setUpHappyPath();
      paymentGateway.charge.mockResolvedValue({
        status: 'FAILED',
        provider: 'mock',
        providerRef: 'mock_ref_declined',
      });

      const result = await service.checkout(CUSTOMER_ID, checkoutDto());

      expect(prisma.paymentTransaction.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'payment-1', status: 'PENDING' },
          data: expect.objectContaining({ status: 'FAILED' }),
        }),
      );
      expect(prisma.order.updateMany).toHaveBeenCalledWith({
        where: { id: 'order-1', status: 'PENDING_PAYMENT' },
        data: { status: 'CANCELLED' },
      });
      expect(catalogServiceClient.releaseInventory).toHaveBeenCalledWith([
        { variantId: VARIANT_A, quantity: 2 },
      ]);
      // A declined payment is a normal, non-throwing outcome — the caller
      // reads the order's own (CANCELLED) status, same as getForCustomer
      // would report afterwards.
      expect(result).toBeDefined();
    });
  });

  describe('checkout — payment gateway unreachable', () => {
    it('finalizes as a failed payment, releases inventory and surfaces 503', async () => {
      const { service, paymentGateway, catalogServiceClient, prisma } =
        setUpHappyPath();
      paymentGateway.charge.mockRejectedValue(new Error('connection refused'));

      await expect(
        service.checkout(CUSTOMER_ID, checkoutDto()),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);

      expect(prisma.order.updateMany).toHaveBeenCalledWith({
        where: { id: 'order-1', status: 'PENDING_PAYMENT' },
        data: { status: 'CANCELLED' },
      });
      expect(catalogServiceClient.releaseInventory).toHaveBeenCalledWith([
        { variantId: VARIANT_A, quantity: 2 },
      ]);
    });
  });

  describe('checkout — order number retry on conflict', () => {
    it('retries when the generated order number collides, then succeeds', async () => {
      const { service, prisma } = setUpHappyPath();
      prisma.order.create
        .mockRejectedValueOnce(uniqueOrderNumberViolation())
        .mockResolvedValueOnce({
          id: 'order-2',
          orderNumber: 'PED-TEST-2',
          customerId: CUSTOMER_ID,
        });
      prisma.order.findFirst.mockResolvedValue({
        id: 'order-2',
        orderNumber: 'PED-TEST-2',
        customerId: CUSTOMER_ID,
      });

      const result = await service.checkout(CUSTOMER_ID, checkoutDto());

      expect(prisma.order.create).toHaveBeenCalledTimes(2);
      expect(result).toEqual(expect.objectContaining({ id: 'order-2' }));
    });

    it('gives up after exhausting the configured retry budget', async () => {
      const { service, prisma } = setUpHappyPath();
      prisma.order.create.mockRejectedValue(uniqueOrderNumberViolation());

      await expect(service.checkout(CUSTOMER_ID, checkoutDto())).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.order.create).toHaveBeenCalledTimes(MAX_ORDER_NUMBER_RETRIES + 1);
    });

    it('rethrows a non-order-number Prisma conflict untouched, without retrying', async () => {
      const { service, prisma } = setUpHappyPath();
      const otherConflict = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed',
        { code: 'P2002', clientVersion: '6.15.0', meta: { target: ['someOtherColumn'] } },
      );
      prisma.order.create.mockRejectedValue(otherConflict);

      await expect(service.checkout(CUSTOMER_ID, checkoutDto())).rejects.toBe(
        otherConflict,
      );
      expect(prisma.order.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('checkout — int4 overflow guard', () => {
    it('rejects a line total that would overflow Postgres int4', async () => {
      const { service, catalogServiceClient } = setUpHappyPath();
      catalogServiceClient.resolveVariants.mockResolvedValue([
        // availableQuantity must cover the requested quantity, otherwise the
        // insufficient-stock check (which runs first) would fire instead of
        // the overflow guard this test targets.
        resolvedVariant({ unitPriceCents: 100_000_000, availableQuantity: 1000 }),
      ]);

      await expect(
        service.checkout(
          CUSTOMER_ID,
          checkoutDto({
            items: [{ productId: PRODUCT_A, variantId: VARIANT_A, quantity: 1000 }],
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts a line total at exactly INT4_MAX', async () => {
      const { service, catalogServiceClient, prisma } = setUpHappyPath();
      catalogServiceClient.resolveVariants.mockResolvedValue([
        resolvedVariant({ unitPriceCents: INT4_MAX }),
      ]);

      await service.checkout(
        CUSTOMER_ID,
        checkoutDto({
          items: [{ productId: PRODUCT_A, variantId: VARIANT_A, quantity: 1 }],
        }),
      );

      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ totalCents: INT4_MAX }),
        }),
      );
    });
  });

  describe('listForCustomer', () => {
    it('scopes the query to the requesting customer', async () => {
      const { service, prisma } = setUpHappyPath();
      prisma.order.findMany.mockResolvedValue([]);

      await service.listForCustomer(CUSTOMER_ID);

      expect(prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { customerId: CUSTOMER_ID } }),
      );
    });

    it('rejects a cursor belonging to another customer as if it did not exist', async () => {
      const { service, prisma } = setUpHappyPath();
      prisma.order.findFirst.mockResolvedValue(null);

      await expect(
        service.listForCustomer(CUSTOMER_ID, { cursor: 'order-of-someone-else' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('getForCustomer', () => {
    it('returns 404 (never 403) for another customer’s order', async () => {
      const { service, prisma } = setUpHappyPath();
      prisma.order.findFirst.mockResolvedValue(null);

      await expect(
        service.getForCustomer(CUSTOMER_ID, 'someone-elses-order'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('scopes the lookup to the requesting customer in SQL, not after the fact', async () => {
      const { service, prisma } = setUpHappyPath();
      prisma.order.findFirst.mockResolvedValue({ id: 'order-1', customerId: CUSTOMER_ID });

      await service.getForCustomer(CUSTOMER_ID, 'order-1');

      expect(prisma.order.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'order-1', customerId: CUSTOMER_ID },
        }),
      );
    });
  });

  describe('listForSeller', () => {
    it('scopes the query to the requesting seller, not the whole order', async () => {
      const { service, prisma } = setUpHappyPath();
      prisma.sellerOrder.findMany.mockResolvedValue([]);

      await service.listForSeller(SELLER_A);

      expect(prisma.sellerOrder.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { sellerId: SELLER_A } }),
      );
    });

    it('rejects a cursor belonging to another store as if it did not exist', async () => {
      const { service, prisma } = setUpHappyPath();
      prisma.sellerOrder.findFirst.mockResolvedValue(null);

      await expect(
        service.listForSeller(SELLER_A, { cursor: 'seller-order-of-someone-else' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('getForSeller', () => {
    it('returns 404 (never 403) for another store’s SellerOrder', async () => {
      const { service, prisma } = setUpHappyPath();
      prisma.sellerOrder.findFirst.mockResolvedValue(null);

      await expect(
        service.getForSeller(SELLER_A, 'someone-elses-seller-order'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('scopes the lookup to the requesting store in SQL, not after the fact', async () => {
      const { service, prisma } = setUpHappyPath();
      prisma.sellerOrder.findFirst.mockResolvedValue({
        id: 'seller-order-1',
        sellerId: SELLER_A,
      });

      await service.getForSeller(SELLER_A, 'seller-order-1');

      expect(prisma.sellerOrder.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'seller-order-1', sellerId: SELLER_A },
        }),
      );
    });
  });

  describe('confirmForSeller (seller can never confirm manually -- bug de producao, 02/10)', () => {
    it('A/B) rejects a PENDING seller order (no manual confirm) and never calls prisma.sellerOrder.update', async () => {
      const { service, prisma } = setUpHappyPath();
      prisma.sellerOrder.findFirst.mockResolvedValue({
        id: 'seller-order-1',
        status: 'PENDING',
      });

      await expect(
        service.confirmForSeller(SELLER_A, 'seller-order-1'),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(prisma.sellerOrder.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'seller-order-1', sellerId: SELLER_A },
        }),
      );
      expect(prisma.sellerOrder.update).not.toHaveBeenCalled();
      expect(prisma.sellerOrder.updateMany).not.toHaveBeenCalled();
    });

    it("rejects regardless of the seller order's current status (unconditional -- no Order.status escape hatch)", async () => {
      const { service, prisma } = setUpHappyPath();
      prisma.sellerOrder.findFirst.mockResolvedValue({
        id: 'seller-order-1',
        status: 'CONFIRMED',
      });

      await expect(
        service.confirmForSeller(SELLER_A, 'seller-order-1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.sellerOrder.update).not.toHaveBeenCalled();
    });

    it("C) 404 (never 403) for another store's seller order -- ownership check still runs first", async () => {
      const { service, prisma } = setUpHappyPath();
      prisma.sellerOrder.findFirst.mockResolvedValue(null);

      await expect(
        service.confirmForSeller(SELLER_A, 'someone-elses-seller-order'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.sellerOrder.update).not.toHaveBeenCalled();
    });
  });

  describe('fulfillment transitions (confirmForSeller/prepareForSeller/shipForSeller/deliverForSeller)', () => {
    const CASES: Array<{
      method: 'prepareForSeller' | 'shipForSeller' | 'deliverForSeller';
      from: string;
      to: string;
    }> = [
      { method: 'prepareForSeller', from: 'CONFIRMED', to: 'PREPARING' },
      { method: 'shipForSeller', from: 'PREPARING', to: 'SHIPPED' },
      { method: 'deliverForSeller', from: 'SHIPPED', to: 'DELIVERED' },
    ];

    for (const { method, from, to } of CASES) {
      it(`${method}: ${from} -> ${to} when the seller order is ${from}`, async () => {
        const { service, prisma } = setUpHappyPath();
        prisma.sellerOrder.findFirst
          .mockResolvedValueOnce({
            id: 'seller-order-1',
            status: from,
            orderId: 'order-1',
          })
          .mockResolvedValueOnce({ id: 'seller-order-1', status: to });

        const result = await service[method](SELLER_A, 'seller-order-1');

        expect(prisma.sellerOrder.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: 'seller-order-1', sellerId: SELLER_A },
          }),
        );
        // F2.2A -- UPDATE condicional ao status esperado, escopado à loja.
        expect(prisma.sellerOrder.updateMany).toHaveBeenCalledWith({
          where: {
            id: 'seller-order-1',
            orderId: 'order-1',
            sellerId: SELLER_A,
            status: from,
          },
          data: { status: to },
        });
        expect(prisma.sellerOrder.update).not.toHaveBeenCalled();
        expect(result).toEqual({ id: 'seller-order-1', status: to });
      });

      it(`${method}: 404 (never 403) for another store's seller order`, async () => {
        const { service, prisma } = setUpHappyPath();
        prisma.sellerOrder.findFirst.mockResolvedValue(null);

        await expect(
          service[method](SELLER_A, 'someone-elses-seller-order'),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(prisma.sellerOrder.update).not.toHaveBeenCalled();
        expect(prisma.sellerOrder.updateMany).not.toHaveBeenCalled();
        expect(prisma.orderStatusHistory.create).not.toHaveBeenCalled();
      });

      it(`${method}: 409 when the seller order is not ${from}`, async () => {
        const { service, prisma } = setUpHappyPath();
        prisma.sellerOrder.findFirst.mockResolvedValue({
          id: 'seller-order-1',
          status: 'CANCELLED',
        });

        await expect(
          service[method](SELLER_A, 'seller-order-1'),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(prisma.sellerOrder.update).not.toHaveBeenCalled();
        expect(prisma.sellerOrder.updateMany).not.toHaveBeenCalled();
        expect(prisma.orderStatusHistory.create).not.toHaveBeenCalled();
      });
    }
  });
});
