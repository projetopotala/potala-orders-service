-- ============================================================================
-- F2.2B-A -- Outbox transacional (somente persistência).
-- Migration ADITIVA, somente no schema "orders": um enum e uma tabela novos,
-- com FKs para "orders"."pedidos" e "orders"."historico_status_pedido".
-- Nenhuma tabela existente é alterada e nenhum dado é inserido: eventos só
-- existem para transições ocorridas depois da ativação (sem backfill).
-- Nenhum publicador existe nesta entrega: as linhas ficam PENDING.
--
-- ESCRITA À MÃO: o schema-engine do Prisma não roda no ambiente de
-- validação. Antes de aplicar em homologação, conferir no Windows com:
--   npx prisma migrate diff --from-migrations prisma/migrations \
--     --to-schema-datamodel prisma/schema.prisma \
--     --shadow-database-url <banco DESCARTÁVEL>
-- (diferença esperada: somente os CHECKs do fim deste arquivo).
--
-- Depende das migrations F2.1 (20261015180000) e F2.2A (20261016180000).
-- NÃO aplicar no Supabase compartilhado. Ver docs/outbox.md.
-- ============================================================================

-- CreateEnum
CREATE TYPE "orders"."OutboxEventStatus" AS ENUM ('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED');

-- CreateTable
CREATE TABLE "orders"."eventos_outbox" (
    "id" UUID NOT NULL,
    "sequencia" BIGSERIAL NOT NULL,
    "tipo_evento" VARCHAR(100) NOT NULL,
    "versao_evento" INTEGER NOT NULL,
    "tipo_agregado" VARCHAR(32) NOT NULL,
    "agregado_id" UUID NOT NULL,
    "pedido_id" UUID NOT NULL,
    "historico_id" UUID,
    "payload" JSONB NOT NULL,
    "correlacao_id" VARCHAR(128),
    "ocorrido_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "orders"."OutboxEventStatus" NOT NULL DEFAULT 'PENDING',
    "tentativas" INTEGER NOT NULL DEFAULT 0,
    "proxima_tentativa_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bloqueado_ate" TIMESTAMP(3),
    "token_processamento" UUID,
    "ultimo_erro" VARCHAR(500),
    "publicado_em" TIMESTAMP(3),

    CONSTRAINT "eventos_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "eventos_outbox_sequencia_key" ON "orders"."eventos_outbox"("sequencia");

-- CreateIndex
CREATE UNIQUE INDEX "eventos_outbox_historico_id_key" ON "orders"."eventos_outbox"("historico_id");

-- CreateIndex
CREATE INDEX "eventos_outbox_status_proxima_tentativa_em_idx" ON "orders"."eventos_outbox"("status", "proxima_tentativa_em");

-- CreateIndex
CREATE INDEX "eventos_outbox_tipo_agregado_agregado_id_sequencia_idx" ON "orders"."eventos_outbox"("tipo_agregado", "agregado_id", "sequencia");

-- CreateIndex
CREATE INDEX "eventos_outbox_pedido_id_idx" ON "orders"."eventos_outbox"("pedido_id");

-- AddForeignKey
-- RESTRICT, mesmo padrão do histórico: excluir fisicamente um pedido (ou
-- uma linha de histórico) com eventos falha em vez de apagá-los em silêncio.
ALTER TABLE "orders"."eventos_outbox" ADD CONSTRAINT "eventos_outbox_pedido_id_fkey" FOREIGN KEY ("pedido_id") REFERENCES "orders"."pedidos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders"."eventos_outbox" ADD CONSTRAINT "eventos_outbox_historico_id_fkey" FOREIGN KEY ("historico_id") REFERENCES "orders"."historico_status_pedido"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- CHECKs escritos à mão (o schema Prisma não os expressa).
-- ----------------------------------------------------------------------------

-- Tipo do evento: "orders.<agregado>.<fato>" em minúsculas.
ALTER TABLE "orders"."eventos_outbox" ADD CONSTRAINT "eventos_outbox_tipo_evento_check" CHECK ("tipo_evento" ~ '^orders\.[a-z_]+\.[a-z_]+$');

-- Agregados suportados nesta entrega.
ALTER TABLE "orders"."eventos_outbox" ADD CONSTRAINT "eventos_outbox_tipo_agregado_check" CHECK ("tipo_agregado" IN ('ORDER', 'SELLER_ORDER'));

-- Versão do contrato e contadores de entrega.
ALTER TABLE "orders"."eventos_outbox" ADD CONSTRAINT "eventos_outbox_versao_evento_check" CHECK ("versao_evento" >= 1);
ALTER TABLE "orders"."eventos_outbox" ADD CONSTRAINT "eventos_outbox_tentativas_check" CHECK ("tentativas" >= 0);

-- Payload sempre um objeto JSON.
ALTER TABLE "orders"."eventos_outbox" ADD CONSTRAINT "eventos_outbox_payload_check" CHECK (jsonb_typeof("payload") = 'object');

-- Coerência do estado de publicação: PUBLISHED exige data de publicação;
-- PROCESSING exige lease (prazo e token).
ALTER TABLE "orders"."eventos_outbox" ADD CONSTRAINT "eventos_outbox_estado_check" CHECK (
    ("status" <> 'PUBLISHED' OR "publicado_em" IS NOT NULL)
    AND ("status" <> 'PROCESSING' OR ("bloqueado_ate" IS NOT NULL AND "token_processamento" IS NOT NULL))
);
