import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  OrderStatus,
  OrderStatusHistoryActorType,
  OrderStatusHistoryAggregate,
  OrderStatusHistorySource,
  Prisma,
  SellerOrderStatus,
} from '@prisma/client';
import { buildStatusHistoryOutboxEvent } from './order-outbox-events';

/**
 * Quem/por que de uma transição. `actorId` só quando conhecido; uma
 * transição executada pelo próprio serviço usa actorType SYSTEM e nunca um
 * humano inventado. `reason` é um código fixo (ver ORDER_TRANSITION_REASON),
 * nunca mensagem de erro, payload ou dado pessoal.
 */
export interface OrderTransitionContext {
  source: OrderStatusHistorySource;
  actorType: OrderStatusHistoryActorType;
  actorId?: string | null;
  correlationId?: string | null;
  reason?: string | null;
}

/** Códigos de motivo gravados no histórico (CHECK `^[A-Z][A-Z0-9_]*$`). */
export const ORDER_TRANSITION_REASON = {
  INVENTORY_RESERVATION_FAILED: 'INVENTORY_RESERVATION_FAILED',
  PAYMENT_DECLINED: 'PAYMENT_DECLINED',
  PAYMENT_GATEWAY_UNAVAILABLE: 'PAYMENT_GATEWAY_UNAVAILABLE',
  PAYMENT_APPROVED: 'PAYMENT_APPROVED',
} as const;

/**
 * Subpedidos do pedido fora do status esperado no meio de uma transição
 * coletiva. Não é erro HTTP de domínio: sinaliza estado inconsistente e
 * força o rollback da transação inteira.
 */
export class SellerOrdersStateConflictError extends Error {
  constructor(
    readonly orderId: string,
    readonly expected: SellerOrderStatus,
  ) {
    super(
      `Seller orders of order ${orderId} are not all ${expected}; transition aborted`,
    );
    this.name = 'SellerOrdersStateConflictError';
  }
}

export interface SellerOrderRef {
  sellerOrderId: string;
  orderId: string;
  sellerId: string;
}

/**
 * F2.2A -- ponto único das mudanças de status de Order e SellerOrder.
 *
 * Toda transição é um UPDATE condicional ao status anterior esperado
 * (`updateMany where { id, status: from }`) seguido do INSERT no histórico,
 * os dois com o MESMO `tx` -- quem chama abre a transação e nunca faz
 * chamada HTTP dentro dela. Consequências:
 * - status e histórico entram ou saem juntos (rollback conjunto);
 * - se o UPDATE não acertar a linha (status já mudou: corrida, repetição,
 *   transição inválida), nenhum evento é gravado e o método devolve false
 *   -- quem chama decide entre erro de domínio (409) ou no-op;
 * - duas execuções concorrentes a partir do mesmo status: no Postgres a
 *   segunda espera o lock da linha e reavalia o WHERE depois do commit da
 *   primeira, então só uma acerta (count 1) e só uma grava histórico.
 *
 * A criação de Order/SellerOrder também gera um evento (`fromStatus` NULL),
 * gravado na mesma transação que insere a linha.
 *
 * F2.2B-A -- cada linha de histórico efetiva gera, no MESMO `tx` e logo em
 * seguida, exatamente uma linha na outbox (orders.eventos_outbox), ligada
 * pelo id do histórico. Sem histórico (transição rejeitada) não há evento;
 * falha no histórico ou na outbox desfaz status, histórico e evento juntos.
 * Nada é publicado aqui: não existe publicador nesta entrega.
 */
@Injectable()
export class OrderTransitionsService {
  async recordOrderCreated(
    tx: Prisma.TransactionClient,
    orderId: string,
    status: OrderStatus,
    context: OrderTransitionContext,
  ): Promise<void> {
    await this.appendHistory(
      tx,
      {
        aggregateType: OrderStatusHistoryAggregate.ORDER,
        orderId,
        fromStatus: null,
        toStatus: status,
      },
      context,
    );
  }

  async recordSellerOrderCreated(
    tx: Prisma.TransactionClient,
    ref: SellerOrderRef,
    status: SellerOrderStatus,
    context: OrderTransitionContext,
  ): Promise<void> {
    await this.appendHistory(
      tx,
      {
        aggregateType: OrderStatusHistoryAggregate.SELLER_ORDER,
        orderId: ref.orderId,
        sellerOrderId: ref.sellerOrderId,
        sellerId: ref.sellerId,
        fromStatus: null,
        toStatus: status,
      },
      context,
    );
  }

  /** `from` -> `to` no Order; true só se ESTA chamada mudou o status. */
  async transitionOrder(
    tx: Prisma.TransactionClient,
    orderId: string,
    from: OrderStatus,
    to: OrderStatus,
    context: OrderTransitionContext,
  ): Promise<boolean> {
    const { count } = await tx.order.updateMany({
      where: { id: orderId, status: from },
      data: { status: to },
    });
    if (count !== 1) {
      return false;
    }
    await this.appendHistory(
      tx,
      {
        aggregateType: OrderStatusHistoryAggregate.ORDER,
        orderId,
        fromStatus: from,
        toStatus: to,
      },
      context,
    );
    return true;
  }

  /** `from` -> `to` num SellerOrder; true só se ESTA chamada mudou o status. */
  async transitionSellerOrder(
    tx: Prisma.TransactionClient,
    ref: SellerOrderRef,
    from: SellerOrderStatus,
    to: SellerOrderStatus,
    context: OrderTransitionContext,
  ): Promise<boolean> {
    const { count } = await tx.sellerOrder.updateMany({
      // id + orderId + sellerId: o UPDATE nunca acerta subpedido de outra
      // loja nem de outro pedido, mesmo com uma referência inconsistente.
      where: {
        id: ref.sellerOrderId,
        orderId: ref.orderId,
        sellerId: ref.sellerId,
        status: from,
      },
      data: { status: to },
    });
    if (count !== 1) {
      return false;
    }
    await this.appendHistory(
      tx,
      {
        aggregateType: OrderStatusHistoryAggregate.SELLER_ORDER,
        orderId: ref.orderId,
        sellerOrderId: ref.sellerOrderId,
        sellerId: ref.sellerId,
        fromStatus: from,
        toStatus: to,
      },
      context,
    );
    return true;
  }

  /**
   * true se o pedido tem subpedidos e TODOS estão em `expected`. Pré-condição
   * de qualquer mudança coletiva: quem chama verifica ANTES de mudar o
   * pedido e, se for false, não muda nada (ver OrdersService).
   */
  async allSellerOrdersIn(
    tx: Prisma.TransactionClient,
    orderId: string,
    expected: SellerOrderStatus,
  ): Promise<boolean> {
    const rows = await tx.sellerOrder.findMany({
      where: { orderId },
      select: { status: true },
    });
    return rows.length > 0 && rows.every((row) => row.status === expected);
  }

  /**
   * `from` -> `to` em TODOS os subpedidos do pedido, tudo ou nada: um
   * evento por subpedido, cada um com o próprio sellerId. Se algum
   * subpedido não estiver em `from` -- já antes, ou porque mudou entre a
   * leitura e o UPDATE condicional (corrida) --, lança
   * SellerOrdersStateConflictError e a transação de quem chama é desfeita
   * inteira: nunca sobra pedido alterado com subpedido incompatível.
   */
  async transitionAllSellerOrdersOfOrder(
    tx: Prisma.TransactionClient,
    orderId: string,
    from: SellerOrderStatus,
    to: SellerOrderStatus,
    context: OrderTransitionContext,
  ): Promise<number> {
    const rows = await tx.sellerOrder.findMany({
      where: { orderId },
      select: { id: true, sellerId: true, status: true },
      orderBy: { id: 'asc' },
    });
    if (rows.length === 0 || rows.some((row) => row.status !== from)) {
      throw new SellerOrdersStateConflictError(orderId, from);
    }
    for (const row of rows) {
      const moved = await this.transitionSellerOrder(
        tx,
        { sellerOrderId: row.id, orderId, sellerId: row.sellerId },
        from,
        to,
        context,
      );
      if (!moved) {
        throw new SellerOrdersStateConflictError(orderId, from);
      }
    }
    return rows.length;
  }

  /**
   * Única gravação de histórico do serviço: INSERT no histórico e, em
   * seguida, INSERT do evento na outbox, os dois no MESMO `tx`. Só é
   * chamada depois de uma criação ou de um UPDATE condicional que acertou a
   * linha -- uma linha de histórico efetiva, um evento.
   */
  private async appendHistory(
    tx: Prisma.TransactionClient,
    entry: {
      aggregateType: OrderStatusHistoryAggregate;
      orderId: string;
      sellerOrderId?: string;
      sellerId?: string;
      fromStatus: string | null;
      toStatus: string;
    },
    context: OrderTransitionContext,
  ): Promise<void> {
    const historyId = randomUUID();
    await tx.orderStatusHistory.create({
      data: { id: historyId, ...entry, ...this.contextColumns(context) },
    });
    await tx.outboxEvent.create({
      data: buildStatusHistoryOutboxEvent({
        historyId,
        ...entry,
        source: context.source,
        reason: context.reason ?? null,
        correlationId: context.correlationId ?? null,
      }),
    });
  }

  private contextColumns(context: OrderTransitionContext) {
    return {
      source: context.source,
      actorType: context.actorType,
      actorId: context.actorId ?? null,
      correlationId: context.correlationId ?? null,
      reason: context.reason ?? null,
    };
  }
}
