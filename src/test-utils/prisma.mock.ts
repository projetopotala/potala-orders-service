import { PrismaService } from '../database/prisma.service';

type MockFn = jest.Mock;

export type PrismaMock = {
  order: {
    findFirst: MockFn;
    findMany: MockFn;
    create: MockFn;
    update: MockFn;
  };
  sellerOrder: {
    create: MockFn;
    updateMany: MockFn;
    findMany: MockFn;
    findFirst: MockFn;
  };
  orderItem: {
    create: MockFn;
  };
  paymentTransaction: {
    create: MockFn;
    update: MockFn;
  };
  $transaction: MockFn;
  $queryRaw: MockFn;
};

/**
 * OrdersService.$transaction is called two different ways — a callback form
 * for createOrderWithRetry (`$transaction((tx) => ...)`, tx being the same
 * mock object so nested calls like tx.order.create still hit these same
 * jest.fn()s) and an array form for finalizeApprovedPayment/
 * finalizeFailedPayment (`$transaction([promise, promise, promise])`, where
 * each promise was already produced by calling e.g.
 * `this.prisma.paymentTransaction.update(...)` before the array was built).
 * This mock's $transaction supports both: a function argument is invoked
 * with the same mock as `tx`; an array argument is simply awaited via
 * Promise.all, mirroring what real Prisma does for the array form.
 */
export function createPrismaMock(): PrismaMock & PrismaService {
  const prisma: PrismaMock = {
    order: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    sellerOrder: {
      create: jest.fn(),
      updateMany: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
    },
    orderItem: {
      create: jest.fn(),
    },
    paymentTransaction: {
      create: jest.fn(),
      update: jest.fn(),
    },
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
  };

  prisma.$transaction.mockImplementation(
    async (arg: unknown[] | ((tx: PrismaMock) => unknown)) => {
      if (Array.isArray(arg)) {
        return Promise.all(arg);
      }
      return arg(prisma);
    },
  );

  return prisma as unknown as PrismaMock & PrismaService;
}

export function createConfigMock() {
  return {
    get: jest.fn((key: string) => {
      if (key === 'session') {
        return { cookieName: 'potala_session' };
      }
      if (key === 'frontendUrl') {
        return 'http://localhost:3000';
      }
      if (key === 'nodeEnv') {
        return 'test';
      }
      if (key === 'logHttpBody') {
        return false;
      }
      if (key === 'identityService') {
        return {
          baseUrl: 'http://localhost:3001',
          apiKey: 'test-identity-api-key-not-a-real-secret',
          timeoutMs: 5000,
        };
      }
      if (key === 'catalogService') {
        return {
          baseUrl: 'http://localhost:3003',
          apiKey: 'test-catalog-api-key-not-a-real-secret',
          timeoutMs: 5000,
        };
      }
      return undefined;
    }),
  };
}

/** Fake CatalogServiceClient — every method is a jest.fn() the test configures per-case. */
export function createCatalogServiceClientMock() {
  return {
    resolveVariants: jest.fn(),
    reserveInventory: jest.fn(),
    releaseInventory: jest.fn(),
    commitInventory: jest.fn(),
  };
}

/** Fake PaymentGatewayClient — bound to PAYMENT_GATEWAY_CLIENT in tests, same token production code uses. */
export function createPaymentGatewayClientMock() {
  return {
    charge: jest.fn(),
  };
}
