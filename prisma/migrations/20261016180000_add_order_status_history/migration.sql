-- ============================================================================
-- F2.2A -- Histórico persistente de status de Order e SellerOrder.
-- Migration ADITIVA, somente no schema "orders": três enums e uma tabela
-- novos, com FKs para "orders"."pedidos" e "orders"."pedidos_vendedor".
-- Nenhuma tabela existente é alterada e nenhum dado é inserido: o histórico
-- começa na ativação; pedidos anteriores ficam sem eventos (sem backfill).
--
-- ESCRITA À MÃO: o schema-engine do Prisma não roda no ambiente de
-- validação (download do engine Linux bloqueado). Antes de aplicar em
-- homologação, conferir no Windows com:
--   npx prisma migrate diff --from-migrations prisma/migrations \
--     --to-schema-datamodel prisma/schema.prisma \
--     --shadow-database-url <banco DESCARTÁVEL>
-- (diferença esperada: somente os CHECKs do fim deste arquivo, que o
-- schema Prisma não sabe expressar).
--
-- NÃO aplicar no Supabase compartilhado. Ver docs/order-status-history.md.
-- ============================================================================

-- CreateEnum
CREATE TYPE "orders"."OrderStatusHistoryAggregate" AS ENUM ('ORDER', 'SELLER_ORDER');

-- CreateEnum
CREATE TYPE "orders"."OrderStatusHistorySource" AS ENUM ('CHECKOUT', 'PAYMENT_CHECKOUT', 'PAYMENT_WEBHOOK', 'SELLER');

-- CreateEnum
CREATE TYPE "orders"."OrderStatusHistoryActorType" AS ENUM ('CUSTOMER', 'SELLER', 'SYSTEM');

-- CreateTable
CREATE TABLE "orders"."historico_status_pedido" (
    "id" UUID NOT NULL,
    "tipo_agregado" "orders"."OrderStatusHistoryAggregate" NOT NULL,
    "pedido_id" UUID NOT NULL,
    "pedido_vendedor_id" UUID,
    "vendedor_id" UUID,
    "status_anterior" VARCHAR(32),
    "status_novo" VARCHAR(32) NOT NULL,
    "origem" "orders"."OrderStatusHistorySource" NOT NULL,
    "tipo_ator" "orders"."OrderStatusHistoryActorType" NOT NULL,
    "ator_id" UUID,
    "correlacao_id" VARCHAR(128),
    "motivo" VARCHAR(100),
    "ocorrido_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "historico_status_pedido_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "historico_status_pedido_pedido_id_ocorrido_em_idx" ON "orders"."historico_status_pedido"("pedido_id", "ocorrido_em");

-- CreateIndex
CREATE INDEX "historico_status_pedido_pedido_vendedor_id_ocorrido_em_idx" ON "orders"."historico_status_pedido"("pedido_vendedor_id", "ocorrido_em");

-- AddForeignKey
-- RESTRICT: excluir fisicamente um pedido ou subpedido com histórico falha,
-- em vez de apagar o histórico em silêncio (Order -> SellerOrder é CASCADE,
-- então a exclusão de um pedido também é barrada pelo histórico do
-- subpedido).
ALTER TABLE "orders"."historico_status_pedido" ADD CONSTRAINT "historico_status_pedido_pedido_id_fkey" FOREIGN KEY ("pedido_id") REFERENCES "orders"."pedidos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders"."historico_status_pedido" ADD CONSTRAINT "historico_status_pedido_pedido_vendedor_id_fkey" FOREIGN KEY ("pedido_vendedor_id") REFERENCES "orders"."pedidos_vendedor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- CHECKs escritos à mão (o schema Prisma não os expressa; mesmo padrão das
-- migrations anteriores).
-- ----------------------------------------------------------------------------

-- Coerência do agregado: ORDER nunca aponta subpedido/vendedor;
-- SELLER_ORDER sempre aponta os dois.
ALTER TABLE "orders"."historico_status_pedido" ADD CONSTRAINT "historico_status_pedido_agregado_check" CHECK (
    ("tipo_agregado" = 'ORDER' AND "pedido_vendedor_id" IS NULL AND "vendedor_id" IS NULL)
    OR ("tipo_agregado" = 'SELLER_ORDER' AND "pedido_vendedor_id" IS NOT NULL AND "vendedor_id" IS NOT NULL)
);

-- Valores de status válidos por agregado (espelham OrderStatus e
-- SellerOrderStatus).
ALTER TABLE "orders"."historico_status_pedido" ADD CONSTRAINT "historico_status_pedido_status_check" CHECK (
    (
        "tipo_agregado" = 'ORDER'
        AND "status_novo" IN ('PENDING_PAYMENT', 'PAID', 'CANCELLED', 'FULFILLING', 'COMPLETED')
        AND ("status_anterior" IS NULL OR "status_anterior" IN ('PENDING_PAYMENT', 'PAID', 'CANCELLED', 'FULFILLING', 'COMPLETED'))
    )
    OR (
        "tipo_agregado" = 'SELLER_ORDER'
        AND "status_novo" IN ('PENDING', 'CONFIRMED', 'PREPARING', 'SHIPPED', 'DELIVERED', 'CANCELLED')
        AND ("status_anterior" IS NULL OR "status_anterior" IN ('PENDING', 'CONFIRMED', 'PREPARING', 'SHIPPED', 'DELIVERED', 'CANCELLED'))
    )
);

-- Um evento só existe para uma mudança real de status.
ALTER TABLE "orders"."historico_status_pedido" ADD CONSTRAINT "historico_status_pedido_mudanca_check" CHECK ("status_anterior" IS NULL OR "status_anterior" <> "status_novo");

-- Motivo: código curto e fixo, nunca texto livre ou mensagem de erro.
ALTER TABLE "orders"."historico_status_pedido" ADD CONSTRAINT "historico_status_pedido_motivo_check" CHECK ("motivo" IS NULL OR "motivo" ~ '^[A-Z][A-Z0-9_]{0,99}$');
