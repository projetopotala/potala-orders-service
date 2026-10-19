import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { MODULE_METADATA } from '@nestjs/common/constants';
import {
  buildStatusHistoryOutboxEvent,
  ORDER_OUTBOX_EVENT_TYPE,
  ORDER_OUTBOX_EVENT_VERSION,
} from './order-outbox-events';
import { OrdersModule } from './orders.module';

const ORDER_ID = '00000000-0000-4000-8000-0000000000d1';
const SELLER_ORDER_ID = '00000000-0000-4000-8000-0000000000d2';
const SELLER_ID = '00000000-0000-4000-8000-0000000000d3';
const HISTORY_ID = '00000000-0000-4000-8000-0000000000d4';
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('F2.2B-A -- contratos dos eventos da outbox', () => {
  it('nomes estáveis no formato do CHECK da migration, todos na versão 1', () => {
    expect(ORDER_OUTBOX_EVENT_TYPE).toEqual({
      ORDER_CREATED: 'orders.order.created',
      ORDER_STATUS_CHANGED: 'orders.order.status_changed',
      SELLER_ORDER_CREATED: 'orders.seller_order.created',
      SELLER_ORDER_STATUS_CHANGED: 'orders.seller_order.status_changed',
    });
    for (const type of Object.values(ORDER_OUTBOX_EVENT_TYPE)) {
      expect(type).toMatch(/^orders\.[a-z_]+\.[a-z_]+$/);
      expect(ORDER_OUTBOX_EVENT_VERSION[type]).toBe(1);
    }
  });

  it('OrderCreated: eventId novo e independente do histórico, vínculo em statusHistoryId', () => {
    const event = buildStatusHistoryOutboxEvent({
      historyId: HISTORY_ID,
      aggregateType: 'ORDER',
      orderId: ORDER_ID,
      fromStatus: null,
      toStatus: 'PENDING_PAYMENT',
      source: 'CHECKOUT',
    });

    expect(event).toEqual({
      id: expect.stringMatching(UUID_V4),
      eventType: 'orders.order.created',
      eventVersion: 1,
      aggregateType: 'ORDER',
      aggregateId: ORDER_ID,
      orderId: ORDER_ID,
      statusHistoryId: HISTORY_ID,
      payload: {
        orderId: ORDER_ID,
        status: 'PENDING_PAYMENT',
        source: 'CHECKOUT',
      },
      correlationId: null,
    });
    expect(event.id).not.toBe(HISTORY_ID);
    expect(
      buildStatusHistoryOutboxEvent({
        historyId: HISTORY_ID,
        aggregateType: 'ORDER',
        orderId: ORDER_ID,
        fromStatus: null,
        toStatus: 'PENDING_PAYMENT',
        source: 'CHECKOUT',
      }).id,
    ).not.toBe(event.id);
  });

  it('OrderStatusChanged e SellerOrderStatusChanged: de/para, origem, motivo e correlação', () => {
    expect(
      buildStatusHistoryOutboxEvent({
        historyId: HISTORY_ID,
        aggregateType: 'ORDER',
        orderId: ORDER_ID,
        fromStatus: 'PENDING_PAYMENT',
        toStatus: 'CANCELLED',
        source: 'CHECKOUT',
        reason: 'INVENTORY_RESERVATION_FAILED',
        correlationId: 'req-123',
      }),
    ).toEqual(
      expect.objectContaining({
        eventType: 'orders.order.status_changed',
        aggregateType: 'ORDER',
        aggregateId: ORDER_ID,
        correlationId: 'req-123',
        payload: {
          orderId: ORDER_ID,
          fromStatus: 'PENDING_PAYMENT',
          toStatus: 'CANCELLED',
          source: 'CHECKOUT',
          reason: 'INVENTORY_RESERVATION_FAILED',
        },
      }),
    );
    expect(
      buildStatusHistoryOutboxEvent({
        historyId: HISTORY_ID,
        aggregateType: 'SELLER_ORDER',
        orderId: ORDER_ID,
        sellerOrderId: SELLER_ORDER_ID,
        sellerId: SELLER_ID,
        fromStatus: 'SHIPPED',
        toStatus: 'DELIVERED',
        source: 'SELLER',
      }),
    ).toEqual(
      expect.objectContaining({
        eventType: 'orders.seller_order.status_changed',
        aggregateType: 'SELLER_ORDER',
        aggregateId: SELLER_ORDER_ID,
        orderId: ORDER_ID,
        payload: {
          orderId: ORDER_ID,
          sellerOrderId: SELLER_ORDER_ID,
          sellerId: SELLER_ID,
          fromStatus: 'SHIPPED',
          toStatus: 'DELIVERED',
          source: 'SELLER',
          reason: null,
        },
      }),
    );
  });

  it('evento de subpedido sem subpedido/loja é recusado (nunca grava evento ambíguo)', () => {
    expect(() =>
      buildStatusHistoryOutboxEvent({
        historyId: HISTORY_ID,
        aggregateType: 'SELLER_ORDER',
        orderId: ORDER_ID,
        fromStatus: null,
        toStatus: 'PENDING',
        source: 'CHECKOUT',
      }),
    ).toThrow();
  });
});

describe('F2.2B-A -- nenhum publicador existe nesta entrega', () => {
  const SRC = join(__dirname, '..', '..');

  function productionFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        return productionFiles(path);
      }
      return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
    });
  }

  it('o código de produção só INSERE na outbox: nenhuma leitura, atualização, exclusão, timer ou agendamento', () => {
    const offenders: string[] = [];
    for (const file of productionFiles(SRC)) {
      if (file.includes(`${join('src', 'test-utils')}`)) {
        continue;
      }
      const source = readFileSync(file, 'utf8');
      const patterns = [
        /outboxEvent\.(?!create\b)[a-zA-Z]+/,
        // SQL cru sobre a tabela (claim/atualização de um publicador)
        /"eventos_outbox"/,
        /setInterval\(/,
        /@Cron\(|@Interval\(|ScheduleModule/,
        /class \w*(Publisher|Dispatcher|Relay)\b/,
      ];
      for (const pattern of patterns) {
        if (pattern.test(source)) {
          offenders.push(`${file}: ${pattern}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('OrdersModule não registra nenhum provider de publicação', () => {
    const providers = (Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      OrdersModule,
    ) ?? []) as Array<{ name?: string; provide?: unknown }>;
    const names = providers.map((provider) =>
      String(provider.name ?? provider.provide ?? ''),
    );
    expect(
      names.some((name) => /publish|dispatch|relay|outbox/i.test(name)),
    ).toBe(false);
  });
});
