import { ConflictException, NotFoundException } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { CheckoutIdempotencyService } from './checkout-idempotency.service';
import {
  OrderTransitionsService,
  SellerOrdersStateConflictError,
} from './order-transitions.service';
import {
  createCatalogServiceClientMock,
  createCouponsServiceMock,
  createPaymentGatewayClientMock,
  createPrismaMock,
} from '../../test-utils/prisma.mock';
import { CreateCheckoutDto } from './dto/create-checkout.dto';

/**
 * F2.2A -- histórico persistente e transições condicionadas ao status.
 *
 * TESTES MOCKADOS. O MemoryDb abaixo reproduz só o que a lógica usa:
 * UPDATE condicional (`updateMany where { ..., status }` devolve count 0
 * quando o status já mudou) e rollback do que foi gravado dentro de
 * `$transaction(fn)` quando fn lança. Eles provam a ORQUESTRAÇÃO (quem
 * grava, quando, quantos eventos, o que é desfeito). A atomicidade real do
 * PostgreSQL (lock de linha, reavaliação do WHERE em READ COMMITTED,
 * rollback físico) NÃO é provada aqui -- fica para a homologação isolada.
 */

const CUSTOMER = '00000000-0000-4000-8000-000000000c01';
const STORE_USER_A = '00000000-0000-4000-8000-0000000000a9';
const PRODUCT_A = '00000000-0000-4000-8000-00000000a001';
const VARIANT_A = '00000000-0000-4000-8000-00000000a002';
const SELLER_A = '00000000-0000-4000-8000-00000000a003';
const PRODUCT_B = '00000000-0000-4000-8000-00000000b001';
const VARIANT_B = '00000000-0000-4000-8000-00000000b002';
const SELLER_B = '00000000-0000-4000-8000-00000000b003';

type Row = Record<string, unknown>;
type Undo = () => void;

class MemoryDb {
  readonly orders: Row[] = [];
  readonly sellerOrders: Row[] = [];
  readonly orderItems: Row[] = [];
  readonly payments: Row[] = [];
  readonly history: Row[] = [];
  /** Faz o próximo INSERT no histórico falhar (teste de rollback). */
  failNextHistoryInsert = false;
  /** Faz o próximo UPDATE condicional de Order falhar (erro de banco). */
  failNextOrderUpdate = false;
  private sequence = 0;

  readonly client = {
    ...this.delegates(null),
    $transaction: async (arg: unknown): Promise<unknown> => {
      if (typeof arg !== 'function') {
        throw new Error('F2.2A: OrdersService só deve usar $transaction(fn)');
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
    Object.assign(row, data);
    undo?.push(() => {
      Object.keys(row).forEach((key) => delete row[key]);
      Object.assign(row, previous);
    });
  }

  private matches(row: Row, where: Row): boolean {
    return Object.entries(where).every(
      ([field, value]) => row[field] === value,
    );
  }

  private updateWhere(
    table: Row[],
    where: Row,
    data: Row,
    undo: Undo[] | null,
  ) {
    const hits = table.filter((row) => this.matches(row, where));
    hits.forEach((row) => this.patch(row, data, undo));
    return { count: hits.length };
  }

  private delegates(undo: Undo[] | null) {
    return {
      order: {
        create: jest.fn(async ({ data }: { data: Row }) => {
          const { shippingAddress: _address, ...columns } = data;
          return this.insert(
            this.orders,
            { id: this.nextId('order'), ...columns },
            undo,
          );
        }),
        updateMany: jest.fn(
          async ({ where, data }: { where: Row; data: Row }) => {
            if (this.failNextOrderUpdate) {
              this.failNextOrderUpdate = false;
              throw new Error('simulated database failure on order update');
            }
            return this.updateWhere(this.orders, where, data, undo);
          },
        ),
        findFirst: jest.fn(async ({ where }: { where: Row }) => {
          const order = this.orders.find(
            (row) => row.id === where.id && row.customerId === where.customerId,
          );
          return order
            ? {
                ...order,
                sellerOrders: this.sellerOrders.filter(
                  (row) => row.orderId === order.id,
                ),
                paymentTransactions: this.payments.filter(
                  (row) => row.orderId === order.id,
                ),
              }
            : null;
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
          async ({ where, data }: { where: Row; data: Row }) =>
            this.updateWhere(this.sellerOrders, where, data, undo),
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
        findFirst: jest.fn(async ({ where }: { where: Row }) => {
          const row = this.sellerOrders.find((candidate) =>
            this.matches(candidate, where),
          );
          return row ? { ...row } : null;
        }),
      },
      orderItem: {
        create: jest.fn(async ({ data }: { data: Row }) =>
          this.insert(
            this.orderItems,
            { id: this.nextId('item'), ...data },
            undo,
          ),
        ),
        findMany: jest.fn(
          async ({
            where,
          }: {
            where: { sellerOrder: { orderId: string } };
          }) => {
            const ids = this.sellerOrders
              .filter((row) => row.orderId === where.sellerOrder.orderId)
              .map((row) => row.id);
            return this.orderItems
              .filter((row) => ids.includes(row.sellerOrderId))
              .map((row) => ({
                variantId: row.variantId,
                quantity: row.quantity,
              }));
          },
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
        updateMany: jest.fn(
          async ({ where, data }: { where: Row; data: Row }) =>
            this.updateWhere(this.payments, where, data, undo),
        ),
        findUnique: jest.fn(
          async ({ where }: { where: { provider_providerRef: Row } }) => {
            const found = this.payments.find(
              (row) =>
                row.provider === where.provider_providerRef.provider &&
                row.providerRef === where.provider_providerRef.providerRef,
            );
            return found ? { ...found } : null;
          },
        ),
      },
      orderStatusHistory: {
        create: jest.fn(async ({ data }: { data: Row }) => {
          if (this.failNextHistoryInsert) {
            this.failNextHistoryInsert = false;
            throw new Error('simulated failure writing order status history');
          }
          return this.insert(
            this.history,
            { id: this.nextId('event'), ...data },
            undo,
          );
        }),
      },
    };
  }

  /** Atalho de teste: pedido + subpedidos já gravados em um status dado. */
  seedOrder(
    status: string,
    sellerOrders: Array<{ sellerId: string; status: string }>,
  ): { orderId: string; sellerOrderIds: string[] } {
    const order = this.insert(
      this.orders,
      {
        id: this.nextId('order'),
        customerId: CUSTOMER,
        orderNumber: 'PED-SEED',
        status,
      },
      null,
    );
    const sellerOrderIds = sellerOrders.map(
      (seed) =>
        this.insert(
          this.sellerOrders,
          { id: this.nextId('seller-order'), orderId: order.id, ...seed },
          null,
        ).id as string,
    );
    return { orderId: order.id as string, sellerOrderIds };
  }

  /** Atalho de teste: transação de pagamento PENDING já localizável pelo webhook. */
  seedPendingPayment(orderId: string, providerRef: string): string {
    return this.insert(
      this.payments,
      {
        id: this.nextId('payment'),
        orderId,
        status: 'PENDING',
        amountCents: 1000,
        provider: 'mock',
        providerRef,
      },
      null,
    ).id as string;
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

function twoSellerCart(): CreateCheckoutDto {
  return {
    items: [
      { productId: PRODUCT_A, variantId: VARIANT_A, quantity: 1 },
      { productId: PRODUCT_B, variantId: VARIANT_B, quantity: 2 },
    ],
    shippingAddress: {
      recipient: 'Maria Silva',
      street: 'Rua das Flores',
      number: '123',
      neighborhood: 'Centro',
      city: 'São Paulo',
      state: 'SP',
      postalCode: '01310-000',
    },
  } as CreateCheckoutDto;
}

function setUp() {
  const db = new MemoryDb();
  const catalog = createCatalogServiceClientMock();
  const gateway = createPaymentGatewayClientMock();
  catalog.resolveVariants.mockResolvedValue([
    variant(),
    variant({
      variantId: VARIANT_B,
      productId: PRODUCT_B,
      sellerId: SELLER_B,
      productTitle: 'Produto B',
      sku: 'SKU-B',
      unitPriceCents: 500,
    }),
  ]);
  catalog.reserveInventory.mockResolvedValue(undefined);
  catalog.commitInventory.mockResolvedValue(undefined);
  catalog.releaseInventory.mockResolvedValue(undefined);
  gateway.charge.mockResolvedValue({
    status: 'APPROVED',
    provider: 'mock',
    providerRef: 'mock_ref_1',
  });
  const service = new OrdersService(
    db.client as never,
    catalog as never,
    gateway as never,
    createCouponsServiceMock() as never,
    new CheckoutIdempotencyService(db.client as never),
    new OrderTransitionsService(),
  );
  return { db, catalog, gateway, service };
}

function eventsOf(db: MemoryDb, filter: Row = {}) {
  return db.history.filter((event) =>
    Object.entries(filter).every(([field, value]) => event[field] === value),
  );
}

describe('OrderTransitionsService (unidade, com mock)', () => {
  const transitions = new OrderTransitionsService();
  const context = {
    source: 'CHECKOUT' as const,
    actorType: 'SYSTEM' as const,
    reason: 'INVENTORY_RESERVATION_FAILED',
  };

  it('A) transição válida: UPDATE condicional ao status anterior + exatamente 1 evento', async () => {
    const prisma = createPrismaMock();

    const moved = await transitions.transitionOrder(
      prisma as never,
      'order-1',
      'PENDING_PAYMENT',
      'CANCELLED',
      context,
    );

    expect(moved).toBe(true);
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', status: 'PENDING_PAYMENT' },
      data: { status: 'CANCELLED' },
    });
    expect(prisma.orderStatusHistory.create).toHaveBeenCalledTimes(1);
    expect(prisma.orderStatusHistory.create).toHaveBeenCalledWith({
      data: {
        aggregateType: 'ORDER',
        orderId: 'order-1',
        fromStatus: 'PENDING_PAYMENT',
        toStatus: 'CANCELLED',
        source: 'CHECKOUT',
        actorType: 'SYSTEM',
        actorId: null,
        correlationId: null,
        reason: 'INVENTORY_RESERVATION_FAILED',
      },
    });
  });

  it('B) status já diferente do esperado (count 0): devolve false e não grava evento', async () => {
    const prisma = createPrismaMock();
    prisma.order.updateMany.mockResolvedValue({ count: 0 });

    const moved = await transitions.transitionOrder(
      prisma as never,
      'order-1',
      'PENDING_PAYMENT',
      'PAID',
      context,
    );

    expect(moved).toBe(false);
    expect(prisma.orderStatusHistory.create).not.toHaveBeenCalled();
  });

  it('D) falha no UPDATE de status: o erro propaga e nenhum evento é gravado', async () => {
    const prisma = createPrismaMock();
    prisma.order.updateMany.mockRejectedValue(new Error('db down'));

    await expect(
      transitions.transitionOrder(
        prisma as never,
        'order-1',
        'PENDING_PAYMENT',
        'PAID',
        context,
      ),
    ).rejects.toThrow('db down');
    expect(prisma.orderStatusHistory.create).not.toHaveBeenCalled();
  });

  it('L) UPDATE de subpedido sempre escopado a id + pedido + loja + status', async () => {
    const prisma = createPrismaMock();

    await transitions.transitionSellerOrder(
      prisma as never,
      { sellerOrderId: 'so-a', orderId: 'order-1', sellerId: SELLER_A },
      'CONFIRMED',
      'PREPARING',
      { source: 'SELLER', actorType: 'SELLER', actorId: STORE_USER_A },
    );

    expect(prisma.sellerOrder.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'so-a',
        orderId: 'order-1',
        sellerId: SELLER_A,
        status: 'CONFIRMED',
      },
      data: { status: 'PREPARING' },
    });
    expect(prisma.orderStatusHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        aggregateType: 'SELLER_ORDER',
        sellerOrderId: 'so-a',
        sellerId: SELLER_A,
        actorType: 'SELLER',
        actorId: STORE_USER_A,
      }),
    });
  });
});

describe('F2.2A -- checkout multivendedor e histórico (MemoryDb)', () => {
  it('F) cria 1 evento de pedido + 1 por subpedido (loja certa) e, na aprovação, PAID + CONFIRMED por loja', async () => {
    const { db, service, catalog } = setUp();

    const order = await service.checkout(CUSTOMER, twoSellerCart());

    expect(order.status).toBe('PAID');
    const creation = eventsOf(db, { fromStatus: null });
    expect(creation).toHaveLength(3);
    expect(eventsOf(db, { aggregateType: 'ORDER', fromStatus: null })).toEqual([
      expect.objectContaining({
        toStatus: 'PENDING_PAYMENT',
        source: 'CHECKOUT',
        actorType: 'CUSTOMER',
        actorId: CUSTOMER,
      }),
    ]);
    for (const sellerOrder of db.sellerOrders) {
      const events = eventsOf(db, { sellerOrderId: sellerOrder.id });
      expect(events.map((event) => [event.fromStatus, event.toStatus])).toEqual(
        [
          [null, 'PENDING'],
          ['PENDING', 'CONFIRMED'],
        ],
      );
      // L) nenhum evento do subpedido carrega outra loja.
      expect(
        events.every((event) => event.sellerId === sellerOrder.sellerId),
      ).toBe(true);
    }
    expect(eventsOf(db, { aggregateType: 'ORDER', toStatus: 'PAID' })).toEqual([
      expect.objectContaining({
        fromStatus: 'PENDING_PAYMENT',
        source: 'PAYMENT_CHECKOUT',
        actorType: 'SYSTEM',
        actorId: null,
        reason: 'PAYMENT_APPROVED',
      }),
    ]);
    expect(db.history).toHaveLength(6);
    expect(catalog.commitInventory).toHaveBeenCalledTimes(1);
  });

  it('G) falha na reserva: pedido e TODOS os subpedidos PENDING viram CANCELLED juntos, com eventos, sem liberar estoque nem cobrar', async () => {
    const { db, service, catalog, gateway } = setUp();
    catalog.reserveInventory.mockRejectedValue(
      new ConflictException('Insufficient stock'),
    );

    await expect(
      service.checkout(CUSTOMER, twoSellerCart()),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(db.orders[0].status).toBe('CANCELLED');
    expect(db.sellerOrders.map((row) => row.status)).toEqual([
      'CANCELLED',
      'CANCELLED',
    ]);
    const cancellations = eventsOf(db, { toStatus: 'CANCELLED' });
    expect(cancellations).toHaveLength(3);
    expect(
      cancellations.every(
        (event) =>
          event.source === 'CHECKOUT' &&
          event.actorType === 'SYSTEM' &&
          event.actorId === null &&
          event.reason === 'INVENTORY_RESERVATION_FAILED',
      ),
    ).toBe(true);
    expect(catalog.releaseInventory).not.toHaveBeenCalled();
    expect(gateway.charge).not.toHaveBeenCalled();
  });

  it('G) pagamento recusado: pedido + subpedidos CANCELLED com motivo PAYMENT_DECLINED; estoque liberado uma vez', async () => {
    const { db, service, catalog, gateway } = setUp();
    gateway.charge.mockResolvedValue({
      status: 'FAILED',
      provider: 'mock',
      providerRef: 'mock_ref_declined',
    });

    const order = await service.checkout(CUSTOMER, twoSellerCart());

    expect(order.status).toBe('CANCELLED');
    expect(db.sellerOrders.map((row) => row.status)).toEqual([
      'CANCELLED',
      'CANCELLED',
    ]);
    expect(db.payments[0].status).toBe('FAILED');
    expect(
      eventsOf(db, { toStatus: 'CANCELLED', reason: 'PAYMENT_DECLINED' }),
    ).toHaveLength(3);
    expect(catalog.releaseInventory).toHaveBeenCalledTimes(1);
  });

  it('G) transição coletiva é tudo ou nada: com um subpedido já CONFIRMED, nenhum subpedido muda e nenhum evento fica', async () => {
    const { db } = setUp();
    const { orderId } = db.seedOrder('PENDING_PAYMENT', [
      { sellerId: SELLER_A, status: 'PENDING' },
      { sellerId: SELLER_B, status: 'CONFIRMED' },
    ]);

    await expect(
      db.client.$transaction((tx: never) =>
        new OrderTransitionsService().transitionAllSellerOrdersOfOrder(
          tx,
          orderId,
          'PENDING',
          'CANCELLED',
          { source: 'CHECKOUT', actorType: 'SYSTEM' },
        ),
      ),
    ).rejects.toBeInstanceOf(SellerOrdersStateConflictError);

    expect(db.sellerOrders.map((row) => row.status)).toEqual([
      'PENDING',
      'CONFIRMED',
    ]);
    expect(db.history).toHaveLength(0);
  });

  it('C) falha ao gravar o histórico desfaz a transição (status volta ao anterior, nenhum evento)', async () => {
    const { db, service, catalog } = setUp();
    // A reserva falha e o INSERT do evento de cancelamento (o primeiro
    // depois dos 3 eventos de criação, já confirmados) também falha.
    catalog.reserveInventory.mockImplementation(async () => {
      db.failNextHistoryInsert = true;
      throw new ConflictException('Insufficient stock');
    });

    await expect(service.checkout(CUSTOMER, twoSellerCart())).rejects.toThrow(
      'simulated failure writing order status history',
    );

    // O pedido continua PENDING_PAYMENT (UPDATE desfeito) e só existem os
    // 3 eventos de criação: nenhum evento de cancelamento ficou gravado.
    expect(db.orders[0].status).toBe('PENDING_PAYMENT');
    expect(db.sellerOrders.map((row) => row.status)).toEqual([
      'PENDING',
      'PENDING',
    ]);
    expect(db.history).toHaveLength(3);
    expect(eventsOf(db, { toStatus: 'CANCELLED' })).toHaveLength(0);
  });

  it('D) falha ao atualizar o status do pedido: nenhum evento de transição', async () => {
    const { db, service, catalog } = setUp();
    catalog.reserveInventory.mockImplementation(async () => {
      db.failNextOrderUpdate = true;
      throw new ConflictException('Insufficient stock');
    });

    await expect(service.checkout(CUSTOMER, twoSellerCart())).rejects.toThrow(
      'simulated database failure on order update',
    );

    expect(db.orders[0].status).toBe('PENDING_PAYMENT');
    expect(
      db.history.filter((event) => event.fromStatus !== null),
    ).toHaveLength(0);
  });

  it('J) pagamento PENDING (assíncrono) não é tratado como aprovado: sem PAID, sem CONFIRMED, sem baixa de estoque', async () => {
    const { db, service, catalog, gateway } = setUp();
    gateway.charge.mockResolvedValue({
      status: 'PENDING',
      provider: 'mock',
      providerRef: 'mock_ref_pix',
    });

    const order = await service.checkout(CUSTOMER, twoSellerCart());

    expect(order.status).toBe('PENDING_PAYMENT');
    expect(db.payments[0].status).toBe('PENDING');
    expect(db.sellerOrders.map((row) => row.status)).toEqual([
      'PENDING',
      'PENDING',
    ]);
    expect(eventsOf(db, { toStatus: 'PAID' })).toHaveLength(0);
    expect(eventsOf(db, { toStatus: 'CONFIRMED' })).toHaveLength(0);
    expect(catalog.commitInventory).not.toHaveBeenCalled();
  });
});

describe('F2.2A -- webhook de pagamento (D-A2)', () => {
  async function pendingPixOrder() {
    const ctx = setUp();
    ctx.gateway.charge.mockResolvedValue({
      status: 'PENDING',
      provider: 'mock',
      providerRef: 'mock_ref_pix',
    });
    await ctx.service.checkout(CUSTOMER, twoSellerCart());
    // O provider/ref do PENDING ainda não é gravado no checkout (v1); o
    // webhook localiza a transação por (provider, providerRef).
    Object.assign(ctx.db.payments[0], {
      provider: 'mock',
      providerRef: 'mock_ref_pix',
    });
    return ctx;
  }
  const approved = {
    provider: 'mock',
    providerRef: 'mock_ref_pix',
    status: 'APPROVED' as const,
  };

  it('K) webhook APPROVED repetido: uma única transição (PAID + CONFIRMED) e uma única baixa de estoque', async () => {
    const { db, service, catalog } = await pendingPixOrder();

    await service.confirmPaymentFromWebhook(approved);
    await service.confirmPaymentFromWebhook(approved);

    expect(db.orders[0].status).toBe('PAID');
    expect(
      eventsOf(db, { toStatus: 'PAID', source: 'PAYMENT_WEBHOOK' }),
    ).toHaveLength(1);
    expect(
      eventsOf(db, { toStatus: 'CONFIRMED', source: 'PAYMENT_WEBHOOK' }),
    ).toHaveLength(2);
    expect(catalog.commitInventory).toHaveBeenCalledTimes(1);
  });

  it('K/E) dois webhooks APPROVED simultâneos: só um aplica (UPDATE condicional), estoque baixado uma vez', async () => {
    const { db, service, catalog } = await pendingPixOrder();

    await Promise.all([
      service.confirmPaymentFromWebhook(approved),
      service.confirmPaymentFromWebhook(approved),
    ]);

    expect(eventsOf(db, { toStatus: 'PAID' })).toHaveLength(1);
    expect(catalog.commitInventory).toHaveBeenCalledTimes(1);
  });

  it('K) webhook FAILED depois de APPROVED é ignorado (nada muda, nada é liberado)', async () => {
    const { db, service, catalog } = await pendingPixOrder();
    await service.confirmPaymentFromWebhook(approved);
    const before = db.history.length;

    await service.confirmPaymentFromWebhook({ ...approved, status: 'FAILED' });

    expect(db.orders[0].status).toBe('PAID');
    expect(db.history).toHaveLength(before);
    expect(catalog.releaseInventory).not.toHaveBeenCalled();
  });

  it('K/D-A2) webhooks APPROVED e FAILED simultâneos: o primeiro vence e o pagamento nunca contradiz o pedido', async () => {
    const { db, service, catalog } = await pendingPixOrder();

    await Promise.all([
      service.confirmPaymentFromWebhook(approved),
      service.confirmPaymentFromWebhook({ ...approved, status: 'FAILED' }),
    ]);

    expect(db.payments[0].status).toBe('APPROVED');
    expect(db.orders[0].status).toBe('PAID');
    expect(eventsOf(db, { toStatus: 'CANCELLED' })).toHaveLength(0);
    expect(catalog.commitInventory).toHaveBeenCalledTimes(1);
    expect(catalog.releaseInventory).not.toHaveBeenCalled();
  });

  it('D-A2) aprovação para pedido já CANCELLED nunca o transforma em PAID e não baixa estoque', async () => {
    const { db, service, catalog } = await pendingPixOrder();
    // Pedido cancelado por outro caminho enquanto o pagamento ainda estava PENDING.
    db.orders[0].status = 'CANCELLED';
    const before = db.history.length;

    await service.confirmPaymentFromWebhook(approved);

    expect(db.orders[0].status).toBe('CANCELLED');
    expect(eventsOf(db, { toStatus: 'PAID' })).toHaveLength(0);
    expect(db.history).toHaveLength(before);
    expect(catalog.commitInventory).not.toHaveBeenCalled();
    // A transação registra o fato do provedor (aprovado) para a reconciliação.
    expect(db.payments[0].status).toBe('APPROVED');
  });
});

describe('F2.2A (revisão) -- coerência Order x SellerOrders em estados inesperados', () => {
  // Estados que nenhum fluxo atual produz (todo subpedido nasce PENDING com
  // o pedido PENDING_PAYMENT e só muda junto com ele), mas que dados
  // editados à mão ou código futuro podem criar. A regra: o pedido NUNCA
  // muda de status deixando um subpedido incompatível para trás.
  function seeded(sellerStatuses: [string, string]) {
    const ctx = setUp();
    const seed = ctx.db.seedOrder('PENDING_PAYMENT', [
      { sellerId: SELLER_A, status: sellerStatuses[0] },
      { sellerId: SELLER_B, status: sellerStatuses[1] },
    ]);
    const paymentId = ctx.db.seedPendingPayment(seed.orderId, 'mock_ref_x');
    return { ...ctx, ...seed, paymentId };
  }
  const approvedEvent = {
    provider: 'mock',
    providerRef: 'mock_ref_x',
    status: 'APPROVED' as const,
  };

  it('aprovação com um subpedido CANCELLED: pedido NÃO vira PAID, nenhum subpedido muda, nenhum evento, sem baixa de estoque; o pagamento fica registrado', async () => {
    const { db, service, catalog } = seeded(['PENDING', 'CANCELLED']);

    await service.confirmPaymentFromWebhook(approvedEvent);

    expect(db.orders[0].status).toBe('PENDING_PAYMENT');
    expect(db.sellerOrders.map((row) => row.status)).toEqual([
      'PENDING',
      'CANCELLED',
    ]);
    expect(db.history).toHaveLength(0);
    expect(catalog.commitInventory).not.toHaveBeenCalled();
    expect(db.payments[0]).toEqual(
      expect.objectContaining({
        status: 'APPROVED',
        provider: 'mock',
        providerRef: 'mock_ref_x',
      }),
    );
  });

  it('aprovação com um subpedido já CONFIRMED: mesmo tratamento (nada muda no pedido nem nos subpedidos)', async () => {
    const { db, service, catalog } = seeded(['PENDING', 'CONFIRMED']);

    await service.confirmPaymentFromWebhook(approvedEvent);

    expect(db.orders[0].status).toBe('PENDING_PAYMENT');
    expect(db.sellerOrders.map((row) => row.status)).toEqual([
      'PENDING',
      'CONFIRMED',
    ]);
    expect(db.history).toHaveLength(0);
    expect(catalog.commitInventory).not.toHaveBeenCalled();
  });

  it('recusa com um subpedido CONFIRMED: pedido NÃO é cancelado (o subpedido confirmado nunca fica órfão de um pedido cancelado), sem liberar estoque', async () => {
    const { db, service, catalog } = seeded(['PENDING', 'CONFIRMED']);

    await service.confirmPaymentFromWebhook({
      ...approvedEvent,
      status: 'FAILED',
    });

    expect(db.orders[0].status).toBe('PENDING_PAYMENT');
    expect(db.sellerOrders.map((row) => row.status)).toEqual([
      'PENDING',
      'CONFIRMED',
    ]);
    expect(db.history).toHaveLength(0);
    expect(catalog.releaseInventory).not.toHaveBeenCalled();
    expect(db.payments[0].status).toBe('FAILED');
  });

  it('falha da reserva com um subpedido em estado inesperado: pedido não é cancelado, nada muda, o erro original da reserva continua sendo o erro devolvido', async () => {
    const { db, service, catalog, gateway } = setUp();
    const reserveError = new ConflictException('Insufficient stock');
    catalog.reserveInventory.mockImplementation(async () => {
      // estado inesperado criado "por fora" entre a criação e a reserva
      db.sellerOrders[1].status = 'CONFIRMED';
      throw reserveError;
    });

    await expect(service.checkout(CUSTOMER, twoSellerCart())).rejects.toBe(
      reserveError,
    );

    expect(db.orders[0].status).toBe('PENDING_PAYMENT');
    expect(db.sellerOrders.map((row) => row.status)).toEqual([
      'PENDING',
      'CONFIRMED',
    ]);
    expect(eventsOf(db, { toStatus: 'CANCELLED' })).toHaveLength(0);
    expect(catalog.releaseInventory).not.toHaveBeenCalled();
    expect(gateway.charge).not.toHaveBeenCalled();
  });

  it('pedido válido (todos os subpedidos PENDING): comportamento inalterado -- PAID + todos CONFIRMED', async () => {
    const { db, service, catalog } = seeded(['PENDING', 'PENDING']);

    await service.confirmPaymentFromWebhook(approvedEvent);

    expect(db.orders[0].status).toBe('PAID');
    expect(db.sellerOrders.map((row) => row.status)).toEqual([
      'CONFIRMED',
      'CONFIRMED',
    ]);
    expect(db.history).toHaveLength(3);
    expect(catalog.commitInventory).toHaveBeenCalledTimes(1);
  });

  it('concorrência: um subpedido muda de status entre a verificação e o UPDATE condicional -> a transação inteira é desfeita (sem pedido PAID com subpedido para trás)', async () => {
    const { db, orderId } = seeded(['PENDING', 'PENDING']);
    const transitions = new OrderTransitionsService();

    await expect(
      db.client.$transaction(async (tx: never) => {
        const typed = tx as unknown as {
          sellerOrder: { findMany: jest.Mock };
        };
        const realFindMany =
          typed.sellerOrder.findMany.getMockImplementation()!;
        typed.sellerOrder.findMany.mockImplementation(async (args: never) => {
          const rows = await realFindMany(args);
          // outra transação mexe no segundo subpedido logo depois da leitura
          db.sellerOrders[1].status = 'CANCELLED';
          return rows;
        });
        await transitions.transitionOrder(
          tx,
          orderId,
          'PENDING_PAYMENT',
          'PAID',
          { source: 'PAYMENT_WEBHOOK', actorType: 'SYSTEM' },
        );
        await transitions.transitionAllSellerOrdersOfOrder(
          tx,
          orderId,
          'PENDING',
          'CONFIRMED',
          { source: 'PAYMENT_WEBHOOK', actorType: 'SYSTEM' },
        );
      }),
    ).rejects.toThrow();

    // tudo desfeito: pedido e primeiro subpedido voltam, nenhum evento fica
    expect(db.orders[0].status).toBe('PENDING_PAYMENT');
    expect(db.sellerOrders[0].status).toBe('PENDING');
    expect(db.history).toHaveLength(0);
  });
});

describe('F2.2A (revisão) -- pagamento aprovado com estoque não confirmado', () => {
  it('commitInventory falha depois de PAID: estado PAID/APPROVED/CONFIRMED permanece; webhook repetido NÃO repete commit nem transição', async () => {
    const { db, service, catalog } = setUp();
    const { orderId } = db.seedOrder('PENDING_PAYMENT', [
      { sellerId: SELLER_A, status: 'PENDING' },
    ]);
    db.seedPendingPayment(orderId, 'mock_ref_y');
    catalog.commitInventory.mockRejectedValue(new Error('catalog down'));
    const event = {
      provider: 'mock',
      providerRef: 'mock_ref_y',
      status: 'APPROVED' as const,
    };

    await service.confirmPaymentFromWebhook(event);
    await service.confirmPaymentFromWebhook(event);

    expect(db.payments[0].status).toBe('APPROVED');
    expect(db.orders[0].status).toBe('PAID');
    expect(db.sellerOrders[0].status).toBe('CONFIRMED');
    expect(db.history).toHaveLength(2);
    // uma única tentativa de commit (a que falhou); nada é repetido
    expect(catalog.commitInventory).toHaveBeenCalledTimes(1);
    expect(catalog.releaseInventory).not.toHaveBeenCalled();
  });

  it('dado de reconciliação: aprovação tardia para pedido CANCELLED preserva provider/providerRef e é localizável por consulta (transação APPROVED com pedido != PAID)', async () => {
    const { db, service } = setUp();
    const { orderId } = db.seedOrder('CANCELLED', [
      { sellerId: SELLER_A, status: 'CANCELLED' },
    ]);
    db.seedPendingPayment(orderId, 'mock_ref_late');

    await service.confirmPaymentFromWebhook({
      provider: 'mock',
      providerRef: 'mock_ref_late',
      status: 'APPROVED',
    });

    // equivalente em memória de:
    // SELECT t.* FROM orders.transacoes_pagamento t
    //   JOIN orders.pedidos p ON p.id = t.pedido_id
    //  WHERE t.status = 'APPROVED' AND p.status <> 'PAID'
    const anomalies = db.payments.filter(
      (payment) =>
        payment.status === 'APPROVED' &&
        db.orders.find((order) => order.id === payment.orderId)?.status !==
          'PAID',
    );
    expect(anomalies).toEqual([
      expect.objectContaining({
        orderId,
        provider: 'mock',
        providerRef: 'mock_ref_late',
      }),
    ]);
    expect(db.orders[0].status).toBe('CANCELLED');
  });
});

describe('F2.2A -- fulfillment do vendedor', () => {
  function paidOrder() {
    const ctx = setUp();
    const seeded = ctx.db.seedOrder('PAID', [
      { sellerId: SELLER_A, status: 'CONFIRMED' },
      { sellerId: SELLER_B, status: 'CONFIRMED' },
    ]);
    return { ...ctx, ...seeded };
  }

  it('I) CONFIRMED -> PREPARING -> SHIPPED -> DELIVERED: 3 eventos, ator = usuário da loja', async () => {
    const { db, service, sellerOrderIds } = paidOrder();
    const id = sellerOrderIds[0];

    await service.prepareForSeller(SELLER_A, id, STORE_USER_A);
    await service.shipForSeller(SELLER_A, id, STORE_USER_A);
    const delivered = await service.deliverForSeller(
      SELLER_A,
      id,
      STORE_USER_A,
    );

    expect(delivered.status).toBe('DELIVERED');
    expect(
      db.history.map((event) => [event.fromStatus, event.toStatus]),
    ).toEqual([
      ['CONFIRMED', 'PREPARING'],
      ['PREPARING', 'SHIPPED'],
      ['SHIPPED', 'DELIVERED'],
    ]);
    expect(
      db.history.every(
        (event) =>
          event.source === 'SELLER' &&
          event.actorType === 'SELLER' &&
          event.actorId === STORE_USER_A &&
          event.sellerId === SELLER_A,
      ),
    ).toBe(true);
  });

  it('I/B) pular etapa (CONFIRMED -> SHIPPED) é 409 e não grava nada', async () => {
    const { db, service, sellerOrderIds } = paidOrder();

    await expect(
      service.shipForSeller(SELLER_A, sellerOrderIds[0]),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(db.sellerOrders[0].status).toBe('CONFIRMED');
    expect(db.history).toHaveLength(0);
  });

  it('E) dois "preparar" simultâneos do mesmo subpedido: um vence, o outro recebe 409; 1 evento', async () => {
    const { db, service, sellerOrderIds } = paidOrder();

    const results = await Promise.allSettled([
      service.prepareForSeller(SELLER_A, sellerOrderIds[0], STORE_USER_A),
      service.prepareForSeller(SELLER_A, sellerOrderIds[0], STORE_USER_A),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(
      ConflictException,
    );
    expect(db.history).toHaveLength(1);
  });

  it('L) loja B não move nem gera evento no subpedido da loja A (404, nunca 403)', async () => {
    const { db, service, sellerOrderIds } = paidOrder();

    await expect(
      service.prepareForSeller(SELLER_B, sellerOrderIds[0]),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(db.sellerOrders[0].status).toBe('CONFIRMED');
    expect(db.history).toHaveLength(0);
  });

  it('L) preparar o subpedido da loja A não toca o subpedido da loja B do mesmo pedido', async () => {
    const { db, service, sellerOrderIds } = paidOrder();

    await service.prepareForSeller(SELLER_A, sellerOrderIds[0], STORE_USER_A);

    expect(db.sellerOrders[1].status).toBe('CONFIRMED');
    expect(db.history).toEqual([
      expect.objectContaining({
        sellerOrderId: sellerOrderIds[0],
        sellerId: SELLER_A,
      }),
    ]);
  });

  it('M) vendedor nunca confirma pagamento manualmente: 409 em qualquer status, sem evento', async () => {
    const { db, service } = setUp();
    const { sellerOrderIds } = db.seedOrder('PENDING_PAYMENT', [
      { sellerId: SELLER_A, status: 'PENDING' },
    ]);

    await expect(
      service.confirmForSeller(SELLER_A, sellerOrderIds[0]),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(db.sellerOrders[0].status).toBe('PENDING');
    expect(db.orders[0].status).toBe('PENDING_PAYMENT');
    expect(db.history).toHaveLength(0);
  });
});
