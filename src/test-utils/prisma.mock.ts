import { PrismaService } from '../database/prisma.service';

type MockFn = jest.Mock;

export type PrismaMock = {
  order: {
    findFirst: MockFn;
    findMany: MockFn;
    create: MockFn;
    update: MockFn;
    updateMany: MockFn;
  };
  sellerOrder: {
    create: MockFn;
    update: MockFn;
    updateMany: MockFn;
    findMany: MockFn;
    findFirst: MockFn;
  };
  orderItem: {
    create: MockFn;
    findFirst: MockFn;
  };
  review: {
    create: MockFn;
  };
  return: {
    create: MockFn;
    findUnique: MockFn;
    findFirst: MockFn;
    findMany: MockFn;
    update: MockFn;
    updateMany: MockFn;
  };
  /** Pós-venda (fundação P0) -- somente os delegates realmente usados por ClaimsService/DisputesService hoje. */
  claim: {
    create: MockFn;
    findFirst: MockFn;
    findMany: MockFn;
    findUnique: MockFn;
    update: MockFn;
    updateMany: MockFn;
  };
  claimMessage: {
    create: MockFn;
  };
  claimEvidence: {
    create: MockFn;
  };
  dispute: {
    create: MockFn;
    findFirst: MockFn;
    findMany: MockFn;
    findUnique: MockFn;
    update: MockFn;
    updateMany: MockFn;
  };
  disputeDecision: {
    create: MockFn;
  };
  paymentTransaction: {
    create: MockFn;
    update: MockFn;
    updateMany: MockFn;
    findUnique: MockFn;
  };
  /** F2.2A -- histórico de status (OrderTransitionsService). */
  orderStatusHistory: {
    create: MockFn;
  };
  /** F2.2B-A -- outbox (OrderTransitionsService; só INSERT). */
  outboxEvent: {
    create: MockFn;
  };
  /** F2.1 -- idempotência do checkout (CheckoutIdempotencyService). */
  checkoutIdempotencyKey: {
    createMany: MockFn;
    findUnique: MockFn;
    updateMany: MockFn;
    deleteMany: MockFn;
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
 * (F2.2A: OrdersService agora só usa a forma callback; a forma array fica
 * suportada para os demais serviços.)
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
      // F2.2A -- UPDATE condicional ao status esperado: por padrão acerta a
      // linha ({ count: 1 }); testes de corrida/transição inválida
      // sobrescrevem com { count: 0 }.
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    sellerOrder: {
      create: jest.fn(),
      update: jest.fn(),
      // Mesmo padrão CAS de order.updateMany acima (F2.2A).
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      // Default: nenhum subpedido -- testes que precisam configuram.
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
    },
    orderItem: {
      create: jest.fn(),
      findFirst: jest.fn(),
    },
    review: {
      create: jest.fn(),
    },
    return: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      // Default: CAS 'succeeds' ({ count: 1 }) unless a test overrides it to
      // simulate a concurrent status change ({ count: 0 }) -- see
      // ReturnsService.decide / DisputesService.openFromReturnOrigin.
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    claim: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      // Default: CAS 'succeeds' ({ count: 1 }) unless a test overrides it to
      // simulate a concurrent status change ({ count: 0 }) -- see
      // ClaimsService.transitionStatus / addMessage /
      // DisputesService.openFromClaimOrigin.
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    claimMessage: {
      create: jest.fn(),
    },
    claimEvidence: {
      create: jest.fn(),
    },
    dispute: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      // Default: CAS 'succeeds' ({ count: 1 }) unless a test overrides it to
      // simulate a concurrent decision ({ count: 0 }) -- see
      // DisputesService.recordDecision.
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    disputeDecision: {
      create: jest.fn(),
    },
    paymentTransaction: {
      create: jest.fn(),
      update: jest.fn(),
      // F2.2A -- finalização condicionada a status PENDING (mesmo padrão CAS).
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn(),
    },
    orderStatusHistory: {
      create: jest.fn().mockResolvedValue({}),
    },
    outboxEvent: {
      create: jest.fn().mockResolvedValue({}),
    },
    // Default: a chave é nova (INSERT vence) e toda escrita condicional
    // acerta a linha -- testes de concorrência/retry sobrescrevem.
    checkoutIdempotencyKey: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
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
    parseWebhook: jest.fn(),
  };
}

/**
 * Fake CouponsService — OrdersService only calls resolveForCheckout (before
 * the order-creation transaction) and recordUsage (inside it, via `tx`,
 * which in these tests is the same PrismaMock passed to $transaction's
 * callback -- see createPrismaMock's doc comment). Tests that don't set
 * dto.couponCode never hit either method, so the default unconfigured
 * jest.fn()s are enough; a test exercising a coupon configures
 * resolveForCheckout.mockResolvedValue(...) itself.
 */
export function createCouponsServiceMock() {
  return {
    resolveForCheckout: jest.fn(),
    recordUsage: jest.fn(),
  };
}
