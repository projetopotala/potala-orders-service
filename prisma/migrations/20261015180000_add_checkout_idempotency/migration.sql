-- ============================================================================
-- F2.1 -- Idempotência do checkout (POST /orders/checkout, header
-- Idempotency-Key). Migration ADITIVA, somente no schema "orders": um enum e
-- uma tabela novos, FK para "orders"."pedidos". Nenhuma tabela existente é
-- alterada e nenhum dado é inserido.
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
-- NÃO aplicar no Supabase compartilhado. Ver docs/checkout-idempotency.md.
-- ============================================================================

-- CreateEnum
CREATE TYPE "orders"."CheckoutIdempotencyStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "orders"."chaves_idempotencia_checkout" (
    "id" UUID NOT NULL,
    "cliente_id" UUID NOT NULL,
    "chave" VARCHAR(128) NOT NULL,
    "hash_requisicao" CHAR(64) NOT NULL,
    "status" "orders"."CheckoutIdempotencyStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "token_execucao" UUID NOT NULL,
    "bloqueada_ate" TIMESTAMP(3) NOT NULL,
    "pedido_id" UUID,
    "status_resposta" INTEGER,
    "corpo_resposta" JSONB,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMP(3) NOT NULL,
    "concluida_em" TIMESTAMP(3),

    CONSTRAINT "chaves_idempotencia_checkout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "chaves_idempotencia_checkout_pedido_id_key" ON "orders"."chaves_idempotencia_checkout"("pedido_id");

-- CreateIndex
CREATE UNIQUE INDEX "chaves_idempotencia_checkout_cliente_id_chave_key" ON "orders"."chaves_idempotencia_checkout"("cliente_id", "chave");

-- AddForeignKey
ALTER TABLE "orders"."chaves_idempotencia_checkout" ADD CONSTRAINT "chaves_idempotencia_checkout_pedido_id_fkey" FOREIGN KEY ("pedido_id") REFERENCES "orders"."pedidos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddCheckConstraint (hand-added -- Prisma schema syntax has no native CHECK)
-- Mesmo alfabeto/tamanho validados pela API (CHECKOUT_IDEMPOTENCY_KEY_PATTERN).
ALTER TABLE "orders"."chaves_idempotencia_checkout" ADD CONSTRAINT "chaves_idempotencia_checkout_chave_formato_check" CHECK ("chave" ~ '^[A-Za-z0-9._:-]{16,128}$');

-- AddCheckConstraint (hand-added) -- SHA-256 em hexadecimal minúsculo.
ALTER TABLE "orders"."chaves_idempotencia_checkout" ADD CONSTRAINT "chaves_idempotencia_checkout_hash_formato_check" CHECK ("hash_requisicao" ~ '^[0-9a-f]{64}$');

-- AddCheckConstraint (hand-added) -- COMPLETED sempre aponta para um pedido;
-- FAILED sempre guarda a resposta de erro que será repetida.
ALTER TABLE "orders"."chaves_idempotencia_checkout" ADD CONSTRAINT "chaves_idempotencia_checkout_estado_check" CHECK (
    ("status" <> 'COMPLETED' OR "pedido_id" IS NOT NULL)
    AND ("status" <> 'FAILED' OR ("pedido_id" IS NOT NULL AND "status_resposta" IS NOT NULL AND "corpo_resposta" IS NOT NULL))
);

-- AddCheckConstraint (hand-added)
ALTER TABLE "orders"."chaves_idempotencia_checkout" ADD CONSTRAINT "chaves_idempotencia_checkout_status_resposta_check" CHECK ("status_resposta" IS NULL OR "status_resposta" BETWEEN 400 AND 599);
