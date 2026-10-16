import {
  BadRequestException,
  ConflictException,
  HttpException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { CheckoutIdempotencyStatus } from '@prisma/client';
import { OrdersService } from './orders.service';
import {
  CheckoutIdempotencyInProgressException,
  CheckoutIdempotencyService,
} from './checkout-idempotency.service';
import {
  createCatalogServiceClientMock,
  createCouponsServiceMock,
  createPaymentGatewayClientMock,
} from '../../test-utils/prisma.mock';
import { CreateCheckoutDto } from './dto/create-checkout.dto';

/**
 * F2.1 -- fluxo COMPLETO de OrdersService.checkoutWithOptionalKey com o
 * CheckoutIdempotencyService REAL sobre um banco em memória (FakeDb) que
 * reproduz as duas garantias de que a solução depende:
 *   1. UNIQUE (cliente_id, chave): createMany({ skipDuplicates }) devolve
 *      count 0 para a segunda chave igual (INSERT ... ON CONFLICT DO NOTHING);
 *   2. transação: tudo que foi gravado dentro de $transaction(fn) é desfeito
 *      se fn lançar.
 * Isto é um TESTE MOCKADO: prova a lógica de orquestração (quem executa,
 * quem repete, quem recebe 409/422, quantas reservas e cobranças). A
 * atomicidade real no Postgres é validada à parte (SQL concorrente em
 * PostgreSQL 16 descartável) e, para o caminho Prisma -> SQL, pendente de
 * homologação -- ver docs/checkout-idempotency.md.
 */

const CUSTOMER_1 = '00000000-0000-4000-8000-000000000c01';
const CUSTOMER_2 = '00000000-0000-4000-8000-000000000c02';
const PRODUCT_A = '00000000-0000-4000-8000-00000000a001';
const VARIANT_A = '00000000-0000-4000-8000-00000000a002';
const SELLER_A = '00000000-0000-4000-8000-00000000a003';
const PRODUCT_B = '00000000-0000-4000-8000-00000000b001';
const VARIANT_B = '00000000-0000-4000-8000-00000000b002';
const SELLER_B = '00000000-0000-4000-8000-00000000b003';
const KEY_1 = '11111111-1111-4111-8111-111111111111';
const KEY_2 = '22222222-2222-4222-8222-222222222222';

type Row = Record<string, unknown>;
type Undo = () => void;

/** Banco em memória com UNIQUE (cliente, chave) e rollback de transação. */
class FakeDb {
  readonly orders: Row[] = [];
  readonly sellerOrders: Row[] = [];
  readonly orderItems: Row[] = [];
  readonly payments: Row[] = [];
  readonly keys: Row[] = [];
  /** F2.2A -- histórico de status (desfeito junto no rollback). */
  readonly history: Row[] = [];
  private sequence = 0;

  readonly client = {
    ...this.delegates(null),
    $transaction: async (arg: unknown): Promise<unknown> => {
      if (Array.isArray(arg)) {
        return Promise.all(arg as Promise<unknown>[]);
      }
      const undo: Undo[] = [];
      try {
        return await (arg as (tx: unknown) => Promise<unknown>)(
          this.delegates(undo),
        );
      } catch (error) {
        undo.reverse().forEach((step) => step());
        throw error;
      }
    },
  };

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${this.sequence}`;
  }

  private insert(table: Row[], row: Row, undo: Undo[] | null): Row {
    table.push(row);
    undo?.push(() => table.splice(table.indexOf(row), 1));
    return row;
  }

  private patch(row: Row, data: Row, undo: Undo[] | null): void {
    const previous = { ...row };
    Object.assign(row, data, { updatedAt: new Date() });
    undo?.push(() => {
      Object.keys(row).forEach((key) => delete row[key]);
      Object.assign(row, previous);
    });
  }

  private matches(row: Row, where: Row): boolean {
    return Object.entries(where).every(([field, expected]) => {
      const actual = row[field];
      if (
        expected &&
        typeof expected === 'object' &&
        'lte' in (expected as Row)
      ) {
        return (
          (actual as Date).getTime() <=
          ((expected as Row).lte as Date).getTime()
        );
      }
      return actual === expected;
    });
  }

  private delegates(undo: Undo[] | null) {
    return {
      checkoutIdempotencyKey: {
        createMany: jest.fn(async ({ data }: { data: Row[] }) => {
          let count = 0;
          for (const candidate of data) {
            const conflict = this.keys.some(
              (row) =>
                row.id === candidate.id ||
                (row.customerId === candidate.customerId &&
                  row.key === candidate.key),
            );
            if (!conflict) {
              this.insert(
                this.keys,
                {
                  orderId: null,
                  responseStatus: null,
                  responseBody: null,
                  ...candidate,
                },
                undo,
              );
              count += 1;
            }
          }
          return { count };
        }),
        findUnique: jest.fn(
          async ({ where }: { where: { customerId_key: Row } }) => {
            const found = this.keys.find(
              (row) =>
                row.customerId === where.customerId_key.customerId &&
                row.key === where.customerId_key.key,
            );
            return found ? { ...found } : null;
          },
        ),
        updateMany: jest.fn(
          async ({ where, data }: { where: Row; data: Row }) => {
            const hits = this.keys.filter((row) => this.matches(row, where));
            hits.forEach((row) => this.patch(row, data, undo));
            return { count: hits.length };
          },
        ),
        deleteMany: jest.fn(async ({ where }: { where: Row }) => {
          const hits = this.keys.filter((row) => this.matches(row, where));
          hits.forEach((row) => this.keys.splice(this.keys.indexOf(row), 1));
          return { count: hits.length };
        }),
      },
      order: {
        create: jest.fn(async ({ data }: { data: Row }) => {
          const { shippingAddress: _address, ...columns } = data;
          return this.insert(
            this.orders,
            { id: this.nextId('order'), ...columns },
            undo,
          );
        }),
        update: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
          const row = this.orders.find((order) => order.id === where.id) as Row;
          this.patch(row, data, undo);
          return row;
        }),
        // F2.2A -- UPDATE condicional (where inclui o status esperado).
        updateMany: jest.fn(
          async ({ where, data }: { where: Row; data: Row }) => {
            const hits = this.orders.filter((row) => this.matches(row, where));
            hits.forEach((row) => this.patch(row, data, undo));
            return { count: hits.length };
          },
        ),
        findFirst: jest.fn(async ({ where }: { where: Row }) => {
          const order = this.orders.find(
            (row) => row.id === where.id && row.customerId === where.customerId,
          );
          if (!order) {
            return null;
          }
          return {
            ...order,
            sellerOrders: this.sellerOrders.filter(
              (row) => row.orderId === order.id,
            ),
            paymentTransactions: this.payments.filter(
              (row) => row.orderId === order.id,
            ),
          };
        }),
      },
      sellerOrder: {
        create: jest.fn(async ({ data }: { data: Row }) =>
          this.insert(
            this.sellerOrders,
            { id: this.nextId('seller-order'), ...data },
            undo,
          ),
        ),
        updateMany: jest.fn(
          async ({ where, data }: { where: Row; data: Row }) => {
            const hits = this.sellerOrders.filter((row) =>
              this.matches(row, where),
            );
            hits.forEach((row) => this.patch(row, data, undo));
            return { count: hits.length };
          },
        ),
        findMany: jest.fn(async ({ where }: { where: Row }) =>
          this.sellerOrders
            .filter((row) => this.matches(row, where))
            .map((row) => ({
              id: row.id,
              sellerId: row.sellerId,
              status: row.status,
            })),
        ),
      },
      orderStatusHistory: {
        create: jest.fn(async ({ data }: { data: Row }) =>
          this.insert(
            this.history,
            { id: this.nextId('event'), ...data },
            undo,
          ),
        ),
      },
      orderItem: {
        create: jest.fn(async ({ data }: { data: Row }) =>
          this.insert(
            this.orderItems,
            { id: this.nextId('item'), ...data },
            undo,
          ),
        ),
      },
      paymentTransaction: {
        create: jest.fn(async ({ data }: { data: Row }) =>
          this.insert(
            this.payments,
            { id: this.nextId('payment'), ...data },
            undo,
          ),
        ),
        update: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
          const row = this.payments.find(
            (payment) => payment.id === where.id,
          ) as Row;
          this.patch(row, data, undo);
          return row;
        }),
        updateMany: jest.fn(
          async ({ where, data }: { where: Row; data: Row }) => {
            const hits = this.payments.filter((row) =>
              this.matches(row, where),
            );
            hits.forEach((row) => this.patch(row, data, undo));
            return { count: hits.length };
          },
        ),
      },
    };
  }
}

function variant(overrides: Row = {}) {
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

function cart(overrides: Partial<CreateCheckoutDto> = {}): CreateCheckoutDto {
  return {
    items: [{ productId: PRODUCT_A, variantId: VARIANT_A, quantity: 2 }],
    shippingAddress: {
      recipient: 'Maria Silva',
      street: 'Rua das Flores',
      number: '123',
      neighborhood: 'Centro',
      city: 'São Paulo',
      state: 'SP',
      postalCode: '01310-000',
    },
    ...overrides,
  } as CreateCheckoutDto;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setUp() {
  const db = new FakeDb();
  const catalog = createCatalogServiceClientMock();
  const payment = createPaymentGatewayClientMock();
  const coupons = createCouponsServiceMock();
  catalog.resolveVariants.mockResolvedValue([variant()]);
  catalog.reserveInventory.mockResolvedValue(undefined);
  catalog.commitInventory.mockResolvedValue(undefined);
  catalog.releaseInventory.mockResolvedValue(undefined);
  payment.charge.mockResolvedValue({
    status: 'APPROVED',
    provider: 'mock',
    providerRef: 'ref-1',
  });
  const service = new OrdersService(
    db.client as never,
    catalog as never,
    payment as never,
    coupons as never,
    new CheckoutIdempotencyService(db.client as never),
  );
  const checkout = (
    customerId: string,
    key: string | undefined,
    dto: CreateCheckoutDto = cart(),
  ) => service.checkoutWithOptionalKey(customerId, dto, key);
  return { db, catalog, payment, coupons, service, checkout };
}

describe('OrdersService checkout -- F2.1 idempotency (mocked DB with UNIQUE + rollback)', () => {
  it('normal purchase with a key: one order, key COMPLETED and linked to it', async () => {
    const { db, checkout, catalog, payment } = setUp();

    const result = await checkout(CUSTOMER_1, KEY_1);

    expect(result.replayed).toBe(false);
    expect(result.order.status).toBe('PAID');
    expect(db.orders).toHaveLength(1);
    expect(db.keys).toEqual([
      expect.objectContaining({
        customerId: CUSTOMER_1,
        key: KEY_1,
        status: CheckoutIdempotencyStatus.COMPLETED,
        orderId: db.orders[0].id,
      }),
    ]);
    expect(catalog.reserveInventory).toHaveBeenCalledTimes(1);
    expect(payment.charge).toHaveBeenCalledTimes(1);
  });

  it('two consecutive requests with the same key and payload create ONE order; the second is a replay', async () => {
    const { db, checkout, catalog, payment } = setUp();

    const first = await checkout(CUSTOMER_1, KEY_1);
    const second = await checkout(CUSTOMER_1, KEY_1);

    expect(db.orders).toHaveLength(1);
    expect(second.replayed).toBe(true);
    expect(second.order.id).toBe(first.order.id);
    expect(catalog.resolveVariants).toHaveBeenCalledTimes(1);
    expect(catalog.reserveInventory).toHaveBeenCalledTimes(1);
    expect(payment.charge).toHaveBeenCalledTimes(1);
  });

  it('two CONCURRENT requests with the same key: one executes, the other gets 409, then a retry replays', async () => {
    const { db, checkout, catalog, payment } = setUp();
    const reserving = deferred();
    const release = deferred();
    catalog.reserveInventory.mockImplementation(async () => {
      reserving.resolve();
      await release.promise;
    });

    const first = checkout(CUSTOMER_1, KEY_1);
    await reserving.promise; // first already created and linked its order
    const concurrent = await checkout(CUSTOMER_1, KEY_1).catch(
      (error: unknown) => error,
    );
    release.resolve();
    const done = await first;
    const retry = await checkout(CUSTOMER_1, KEY_1);

    expect(concurrent).toBeInstanceOf(CheckoutIdempotencyInProgressException);
    expect((concurrent as HttpException).getStatus()).toBe(409);
    expect(retry.replayed).toBe(true);
    expect(retry.order.id).toBe(done.order.id);
    expect(db.orders).toHaveLength(1);
    expect(catalog.reserveInventory).toHaveBeenCalledTimes(1);
    expect(payment.charge).toHaveBeenCalledTimes(1);
  });

  it('two requests started in the same tick: exactly one order, the other is rejected', async () => {
    const { db, checkout } = setUp();

    const results = await Promise.allSettled([
      checkout(CUSTOMER_1, KEY_1),
      checkout(CUSTOMER_1, KEY_1),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(
      (r) => r.status === 'rejected',
    ) as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ConflictException);
    expect(db.orders).toHaveLength(1);
  });

  it('same key with a different payload is rejected with 422 and creates nothing', async () => {
    const { db, checkout, catalog } = setUp();
    await checkout(CUSTOMER_1, KEY_1);

    const error = await checkout(
      CUSTOMER_1,
      KEY_1,
      cart({
        items: [{ productId: PRODUCT_A, variantId: VARIANT_A, quantity: 3 }],
      }),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect(db.orders).toHaveLength(1);
    expect(catalog.reserveInventory).toHaveBeenCalledTimes(1);
  });

  it('the same key used by two different customers is independent (no cross-user replay)', async () => {
    const { db, checkout } = setUp();

    const one = await checkout(CUSTOMER_1, KEY_1);
    const two = await checkout(CUSTOMER_2, KEY_1);

    expect(two.replayed).toBe(false);
    expect(two.order.id).not.toBe(one.order.id);
    expect(two.order.customerId).toBe(CUSTOMER_2);
    expect(db.orders).toHaveLength(2);
    expect(db.keys).toHaveLength(2);
  });

  it('different keys for the same customer are different purchases', async () => {
    const { db, checkout } = setUp();

    await checkout(CUSTOMER_1, KEY_1);
    await checkout(CUSTOMER_1, KEY_2);

    expect(db.orders).toHaveLength(2);
  });

  it('without the header the legacy behavior is unchanged (each call is a new order, no key stored)', async () => {
    const { db, checkout } = setUp();

    await checkout(CUSTOMER_1, undefined);
    await checkout(CUSTOMER_1, undefined);

    expect(db.orders).toHaveLength(2);
    expect(db.keys).toHaveLength(0);
  });

  it('an invalid header is rejected with 400 before any catalog call or write', async () => {
    const { db, checkout, catalog } = setUp();

    await expect(checkout(CUSTOMER_1, 'short')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(catalog.resolveVariants).not.toHaveBeenCalled();
    expect(db.keys).toHaveLength(0);
  });

  describe('stock failures', () => {
    it('pre-check failure (before the order exists) releases the key; the same request can succeed later', async () => {
      const { db, checkout, catalog } = setUp();
      catalog.resolveVariants.mockResolvedValueOnce([
        variant({ availableQuantity: 1 }),
      ]);

      await expect(checkout(CUSTOMER_1, KEY_1)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(db.orders).toHaveLength(0);
      expect(db.keys).toHaveLength(0);

      const retry = await checkout(CUSTOMER_1, KEY_1);
      expect(retry.replayed).toBe(false);
      expect(db.orders).toHaveLength(1);
    });

    it('reservation failure (after the order exists) is recorded; a retry repeats the error without reserving again', async () => {
      const { db, checkout, catalog, payment } = setUp();
      catalog.reserveInventory.mockRejectedValueOnce(
        new ConflictException('Insufficient stock for one or more items'),
      );

      const first = await checkout(CUSTOMER_1, KEY_1).catch((e: unknown) => e);
      const retry = await checkout(CUSTOMER_1, KEY_1).catch((e: unknown) => e);

      expect((first as HttpException).getStatus()).toBe(409);
      expect((retry as HttpException).getStatus()).toBe(409);
      expect((retry as HttpException).getResponse()).toEqual(
        (first as HttpException).getResponse(),
      );
      expect(db.orders).toHaveLength(1);
      expect(db.orders[0].status).toBe('CANCELLED');
      expect(db.keys[0]).toMatchObject({
        status: CheckoutIdempotencyStatus.FAILED,
        responseStatus: 409,
      });
      expect(catalog.reserveInventory).toHaveBeenCalledTimes(1);
      expect(payment.charge).not.toHaveBeenCalled();
    });
  });

  describe('payment failures', () => {
    it('gateway unreachable: 503 recorded; a retry repeats 503 without a second charge or release', async () => {
      const { db, checkout, catalog, payment } = setUp();
      payment.charge.mockRejectedValueOnce(new Error('socket hang up'));

      const first = await checkout(CUSTOMER_1, KEY_1).catch((e: unknown) => e);
      const retry = await checkout(CUSTOMER_1, KEY_1).catch((e: unknown) => e);

      expect(first).toBeInstanceOf(ServiceUnavailableException);
      expect((retry as HttpException).getStatus()).toBe(503);
      expect(payment.charge).toHaveBeenCalledTimes(1);
      expect(catalog.releaseInventory).toHaveBeenCalledTimes(1);
      expect(db.orders).toHaveLength(1);
      expect(db.orders[0].status).toBe('CANCELLED');
    });

    it('payment declined: 2xx with a CANCELLED order; a retry replays it without charging again', async () => {
      const { db, checkout, payment } = setUp();
      payment.charge.mockResolvedValueOnce({
        status: 'FAILED',
        provider: 'mock',
        providerRef: 'ref-x',
      });

      const first = await checkout(CUSTOMER_1, KEY_1);
      const retry = await checkout(CUSTOMER_1, KEY_1);

      expect(first.order.status).toBe('CANCELLED');
      expect(retry.replayed).toBe(true);
      expect(retry.order.id).toBe(first.order.id);
      expect(payment.charge).toHaveBeenCalledTimes(1);
      expect(db.orders).toHaveLength(1);
    });
  });

  describe('interrupted attempts (process crash / lost response)', () => {
    it('crash BEFORE the order existed: once the lease expires the retry executes exactly once', async () => {
      const { db, checkout, service } = setUp();
      const crashed = new CheckoutIdempotencyService(db.client as never);
      await crashed.begin(CUSTOMER_1, KEY_1, cart()); // claimed, then the process "died"

      await expect(checkout(CUSTOMER_1, KEY_1)).rejects.toBeInstanceOf(
        CheckoutIdempotencyInProgressException,
      );
      db.keys[0].lockedUntil = new Date(Date.now() - 1);

      const retry = await checkout(CUSTOMER_1, KEY_1);
      expect(retry.replayed).toBe(false);
      expect(db.orders).toHaveLength(1);
      expect(db.keys).toHaveLength(1);
      expect(service).toBeDefined();
    });

    it('crash AFTER the order existed: the retry returns that order and never reserves or charges again', async () => {
      const { db, checkout, catalog, payment } = setUp();
      const reserving = deferred();
      catalog.reserveInventory.mockImplementationOnce(async () => {
        reserving.resolve();
        await new Promise(() => undefined); // never returns: the process "died" here
      });
      void checkout(CUSTOMER_1, KEY_1);
      await reserving.promise;
      expect(db.orders).toHaveLength(1);
      db.keys[0].lockedUntil = new Date(Date.now() - 1);

      const retry = await checkout(CUSTOMER_1, KEY_1);

      expect(retry.replayed).toBe(true);
      expect(retry.order.id).toBe(db.orders[0].id);
      expect(retry.order.status).toBe('PENDING_PAYMENT');
      expect(db.orders).toHaveLength(1);
      expect(catalog.reserveInventory).toHaveBeenCalledTimes(1);
      expect(payment.charge).not.toHaveBeenCalled();
    });

    it('a slow original whose lease was taken over cannot create a second order (its transaction rolls back)', async () => {
      const { db, checkout, catalog } = setUp();
      const resolving = deferred();
      const resume = deferred();
      catalog.resolveVariants.mockImplementationOnce(async () => {
        resolving.resolve();
        await resume.promise;
        return [variant()];
      });

      const slow = checkout(CUSTOMER_1, KEY_1).catch((e: unknown) => e);
      await resolving.promise;
      db.keys[0].lockedUntil = new Date(Date.now() - 1);
      const takeover = await checkout(CUSTOMER_1, KEY_1);
      resume.resolve();
      const slowResult = await slow;

      expect(takeover.replayed).toBe(false);
      expect(slowResult).toBeInstanceOf(CheckoutIdempotencyInProgressException);
      expect(db.orders).toHaveLength(1);
      expect(db.sellerOrders).toHaveLength(1);
      expect(db.orderItems).toHaveLength(1);
      expect(catalog.reserveInventory).toHaveBeenCalledTimes(1);
    });
  });

  it('multi-seller checkout: two seller orders once, never duplicated by a replay', async () => {
    const { db, checkout, catalog, payment } = setUp();
    catalog.resolveVariants.mockResolvedValue([
      variant(),
      variant({
        variantId: VARIANT_B,
        productId: PRODUCT_B,
        sellerId: SELLER_B,
        sku: 'SKU-B',
      }),
    ]);
    const multi = cart({
      items: [
        { productId: PRODUCT_A, variantId: VARIANT_A, quantity: 1 },
        { productId: PRODUCT_B, variantId: VARIANT_B, quantity: 2 },
      ],
    });

    const first = await checkout(CUSTOMER_1, KEY_1, multi);
    const retry = await checkout(CUSTOMER_1, KEY_1, multi);

    expect(retry.replayed).toBe(true);
    expect(db.orders).toHaveLength(1);
    expect(db.sellerOrders).toHaveLength(2);
    expect(db.sellerOrders.map((row) => row.sellerId).sort()).toEqual(
      [SELLER_A, SELLER_B].sort(),
    );
    expect(db.sellerOrders.every((row) => row.status === 'CONFIRMED')).toBe(
      true,
    );
    expect(db.orderItems).toHaveLength(2);
    expect(
      (first.order as { sellerOrders: unknown[] }).sellerOrders,
    ).toHaveLength(2);
    expect(payment.charge).toHaveBeenCalledTimes(1);
  });

  describe('P-1 -- unexpected (non-HTTP) error AFTER the order existed: uncertain outcome', () => {
    it('order already PAID but the final read failed: no terminal FAILED; the next retry gets the PAID order, nothing re-executed', async () => {
      const { db, checkout, catalog, payment } = setUp();
      db.client.order.findFirst.mockRejectedValueOnce(
        new Error('connection reset while reading the order'),
      );

      await expect(checkout(CUSTOMER_1, KEY_1)).rejects.toThrow(
        'connection reset',
      );
      expect(db.orders).toHaveLength(1);
      expect(db.orders[0].status).toBe('PAID');
      expect(db.keys[0].status).toBe(CheckoutIdempotencyStatus.IN_PROGRESS);
      expect(db.keys[0].orderId).toBe(db.orders[0].id);
      expect(db.keys[0].responseStatus).toBeNull();
      expect((db.keys[0].lockedUntil as Date).getTime()).toBeLessThanOrEqual(
        Date.now(),
      );

      const retry = await checkout(CUSTOMER_1, KEY_1);

      expect(retry.replayed).toBe(true);
      expect(retry.order.id).toBe(db.orders[0].id);
      expect(retry.order.status).toBe('PAID');
      expect(db.orders).toHaveLength(1);
      expect(catalog.reserveInventory).toHaveBeenCalledTimes(1);
      expect(payment.charge).toHaveBeenCalledTimes(1);
      expect(catalog.commitInventory).toHaveBeenCalledTimes(1);
    });

    it('order left PENDING (failure after the reservation, before the charge): the retry shows it PENDING_PAYMENT -- never as paid -- and never reserves or charges', async () => {
      const { db, checkout, catalog, payment } = setUp();
      db.client.paymentTransaction.create.mockRejectedValueOnce(
        new Error('db unavailable'),
      );

      await expect(checkout(CUSTOMER_1, KEY_1)).rejects.toThrow(
        'db unavailable',
      );
      expect(db.orders[0].status).toBe('PENDING_PAYMENT');

      const retry = await checkout(CUSTOMER_1, KEY_1);

      expect(retry.replayed).toBe(true);
      expect(retry.order.status).toBe('PENDING_PAYMENT');
      expect(retry.order.status).not.toBe('PAID');
      expect(db.orders).toHaveLength(1);
      expect(catalog.reserveInventory).toHaveBeenCalledTimes(1);
      expect(payment.charge).not.toHaveBeenCalled();
    });

    it('repeating the same key many times after an uncertain failure always replays the same order (no 409 loop, no second order)', async () => {
      const { db, checkout, catalog, payment } = setUp();
      db.client.order.findFirst.mockRejectedValueOnce(new Error('transient'));
      await expect(checkout(CUSTOMER_1, KEY_1)).rejects.toThrow('transient');

      const retries = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        retries.push(await checkout(CUSTOMER_1, KEY_1));
      }

      expect(retries.every((result) => result.replayed)).toBe(true);
      expect(new Set(retries.map((result) => result.order.id)).size).toBe(1);
      expect(db.orders).toHaveLength(1);
      expect(db.keys).toHaveLength(1);
      expect(catalog.reserveInventory).toHaveBeenCalledTimes(1);
      expect(payment.charge).toHaveBeenCalledTimes(1);
    });

    it('known HTTP errors after the order existed keep their recorded response (unchanged): reservation 409 is still replayed as 409', async () => {
      const { db, checkout, catalog } = setUp();
      catalog.reserveInventory.mockRejectedValueOnce(
        new ConflictException('Insufficient stock for variant'),
      );

      await expect(checkout(CUSTOMER_1, KEY_1)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(db.keys[0].status).toBe(CheckoutIdempotencyStatus.FAILED);
      expect(db.keys[0].responseStatus).toBe(409);

      const replay = await checkout(CUSTOMER_1, KEY_1).catch(
        (error: unknown) => error,
      );
      expect(replay).toBeInstanceOf(HttpException);
      expect((replay as HttpException).getStatus()).toBe(409);
      expect(catalog.reserveInventory).toHaveBeenCalledTimes(1);
    });
  });
});

describe('F2.2A -- histórico de status junto com a idempotência da F2.1 (mocked DB)', () => {
  it('H) mesma chave duas vezes: os eventos são gravados uma vez; o replay não grava nada', async () => {
    const { db, checkout } = setUp();

    await checkout(CUSTOMER_1, KEY_1);
    const afterFirst = db.history.map((event) => [
      event.aggregateType,
      event.fromStatus,
      event.toStatus,
    ]);
    const replay = await checkout(CUSTOMER_1, KEY_1);

    expect(replay.replayed).toBe(true);
    expect(afterFirst).toEqual([
      ['ORDER', null, 'PENDING_PAYMENT'],
      ['SELLER_ORDER', null, 'PENDING'],
      ['ORDER', 'PENDING_PAYMENT', 'PAID'],
      ['SELLER_ORDER', 'PENDING', 'CONFIRMED'],
    ]);
    expect(db.history).toHaveLength(4);
    expect(db.history.every((event) => event.orderId === db.orders[0].id)).toBe(
      true,
    );
  });

  it('H) duas requisições no mesmo tick com a mesma chave: um pedido, um conjunto de eventos', async () => {
    const { db, checkout } = setUp();

    await Promise.allSettled([
      checkout(CUSTOMER_1, KEY_1),
      checkout(CUSTOMER_1, KEY_1),
    ]);

    expect(db.orders).toHaveLength(1);
    expect(db.history).toHaveLength(4);
  });

  it('H/C) attachOrder falha (posse retomada por outra execução): pedido, subpedidos e eventos de criação são desfeitos juntos', async () => {
    const { db, checkout, catalog } = setUp();
    catalog.resolveVariants.mockImplementation(async () => {
      // Entre o claim e a criação do pedido, outra execução "retoma" a chave.
      db.keys[0].lockToken = '99999999-9999-4999-8999-999999999999';
      return [variant()];
    });

    await expect(checkout(CUSTOMER_1, KEY_1)).rejects.toBeInstanceOf(
      CheckoutIdempotencyInProgressException,
    );

    expect(db.orders).toHaveLength(0);
    expect(db.sellerOrders).toHaveLength(0);
    expect(db.history).toHaveLength(0);
  });

  it('H/G) falha conhecida depois do pedido (reserva 409): pedido e subpedido CANCELLED com eventos; o replay do 409 não grava nada', async () => {
    const { db, checkout, catalog } = setUp();
    catalog.reserveInventory.mockRejectedValueOnce(
      new ConflictException('Insufficient stock for variant'),
    );

    await expect(checkout(CUSTOMER_1, KEY_1)).rejects.toBeInstanceOf(
      ConflictException,
    );
    const events = db.history.length;
    await expect(checkout(CUSTOMER_1, KEY_1)).rejects.toBeInstanceOf(
      HttpException,
    );

    expect(db.orders[0].status).toBe('CANCELLED');
    expect(db.sellerOrders[0].status).toBe('CANCELLED');
    expect(events).toBe(4);
    expect(db.history).toHaveLength(events);
    expect(catalog.reserveInventory).toHaveBeenCalledTimes(1);
  });
});
