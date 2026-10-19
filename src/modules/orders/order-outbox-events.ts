import { randomUUID } from 'crypto';
import {
  OrderStatusHistoryAggregate,
  OrderStatusHistorySource,
  Prisma,
} from '@prisma/client';

/**
 * F2.2B-A -- contratos dos eventos de domínio gravados na outbox
 * (orders.eventos_outbox). Nomes e versões são ESTÁVEIS: uma mudança
 * incompatível no payload exige nova `eventVersion`, nunca alterar a atual.
 *
 * Todos os eventos desta entrega derivam de uma linha EFETIVA do histórico
 * de status (F2.2A). Nenhum evento representa resultado de operação externa
 * (estoque, cobrança): `PAYMENT_APPROVED` como motivo de uma transição diz
 * que o pagamento foi aprovado, nunca que o estoque foi baixado no catálogo.
 * Eventos próprios de PaymentTransaction ficam fora desta entrega.
 */
export const ORDER_OUTBOX_EVENT_TYPE = {
  ORDER_CREATED: 'orders.order.created',
  ORDER_STATUS_CHANGED: 'orders.order.status_changed',
  SELLER_ORDER_CREATED: 'orders.seller_order.created',
  SELLER_ORDER_STATUS_CHANGED: 'orders.seller_order.status_changed',
} as const;

export type OrderOutboxEventType =
  (typeof ORDER_OUTBOX_EVENT_TYPE)[keyof typeof ORDER_OUTBOX_EVENT_TYPE];

/** Versão atual de cada contrato. */
export const ORDER_OUTBOX_EVENT_VERSION: Record<OrderOutboxEventType, number> =
  {
    [ORDER_OUTBOX_EVENT_TYPE.ORDER_CREATED]: 1,
    [ORDER_OUTBOX_EVENT_TYPE.ORDER_STATUS_CHANGED]: 1,
    [ORDER_OUTBOX_EVENT_TYPE.SELLER_ORDER_CREATED]: 1,
    [ORDER_OUTBOX_EVENT_TYPE.SELLER_ORDER_STATUS_CHANGED]: 1,
  };

/**
 * Payloads v1 -- mínimos: identificadores, status, origem e código de
 * motivo. Nunca endereço, e-mail, nome, ator humano, valores, itens,
 * referência de provedor, chave de idempotência ou mensagem de erro.
 */
export interface OrderCreatedPayloadV1 {
  orderId: string;
  status: string;
  source: OrderStatusHistorySource;
}

export interface OrderStatusChangedPayloadV1 {
  orderId: string;
  fromStatus: string;
  toStatus: string;
  source: OrderStatusHistorySource;
  reason: string | null;
}

export interface SellerOrderCreatedPayloadV1 {
  orderId: string;
  sellerOrderId: string;
  sellerId: string;
  status: string;
  source: OrderStatusHistorySource;
}

export interface SellerOrderStatusChangedPayloadV1 {
  orderId: string;
  sellerOrderId: string;
  sellerId: string;
  fromStatus: string;
  toStatus: string;
  source: OrderStatusHistorySource;
  reason: string | null;
}

/** Linha de histórico efetiva da qual o evento deriva. */
export interface StatusHistoryFact {
  historyId: string;
  aggregateType: OrderStatusHistoryAggregate;
  orderId: string;
  sellerOrderId?: string | null;
  sellerId?: string | null;
  fromStatus: string | null;
  toStatus: string;
  source: OrderStatusHistorySource;
  reason?: string | null;
  correlationId?: string | null;
}

/**
 * Monta a linha da outbox para uma linha de histórico efetiva. `id` é o
 * eventId: UUID novo, independente do id do histórico (o vínculo fica em
 * `statusHistoryId`, único). Status de entrega fica no default (PENDING).
 */
export function buildStatusHistoryOutboxEvent(
  fact: StatusHistoryFact,
): Prisma.OutboxEventUncheckedCreateInput {
  const created = fact.fromStatus === null;
  const reason = fact.reason ?? null;

  if (fact.aggregateType === OrderStatusHistoryAggregate.ORDER) {
    const eventType = created
      ? ORDER_OUTBOX_EVENT_TYPE.ORDER_CREATED
      : ORDER_OUTBOX_EVENT_TYPE.ORDER_STATUS_CHANGED;
    const payload: OrderCreatedPayloadV1 | OrderStatusChangedPayloadV1 = created
      ? { orderId: fact.orderId, status: fact.toStatus, source: fact.source }
      : {
          orderId: fact.orderId,
          fromStatus: fact.fromStatus as string,
          toStatus: fact.toStatus,
          source: fact.source,
          reason,
        };
    return row(fact, eventType, 'ORDER', fact.orderId, payload);
  }

  if (!fact.sellerOrderId || !fact.sellerId) {
    throw new Error(
      'Seller order outbox event requires sellerOrderId and sellerId',
    );
  }
  const eventType = created
    ? ORDER_OUTBOX_EVENT_TYPE.SELLER_ORDER_CREATED
    : ORDER_OUTBOX_EVENT_TYPE.SELLER_ORDER_STATUS_CHANGED;
  const payload:
    SellerOrderCreatedPayloadV1 | SellerOrderStatusChangedPayloadV1 = created
    ? {
        orderId: fact.orderId,
        sellerOrderId: fact.sellerOrderId,
        sellerId: fact.sellerId,
        status: fact.toStatus,
        source: fact.source,
      }
    : {
        orderId: fact.orderId,
        sellerOrderId: fact.sellerOrderId,
        sellerId: fact.sellerId,
        fromStatus: fact.fromStatus as string,
        toStatus: fact.toStatus,
        source: fact.source,
        reason,
      };
  return row(fact, eventType, 'SELLER_ORDER', fact.sellerOrderId, payload);
}

function row(
  fact: StatusHistoryFact,
  eventType: OrderOutboxEventType,
  aggregateType: 'ORDER' | 'SELLER_ORDER',
  aggregateId: string,
  payload:
    | OrderCreatedPayloadV1
    | OrderStatusChangedPayloadV1
    | SellerOrderCreatedPayloadV1
    | SellerOrderStatusChangedPayloadV1,
): Prisma.OutboxEventUncheckedCreateInput {
  return {
    id: randomUUID(),
    eventType,
    eventVersion: ORDER_OUTBOX_EVENT_VERSION[eventType],
    aggregateType,
    aggregateId,
    orderId: fact.orderId,
    statusHistoryId: fact.historyId,
    payload: payload as unknown as Prisma.InputJsonObject,
    correlationId: fact.correlationId ?? null,
  };
}
