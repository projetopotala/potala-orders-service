-- CreateSchema
-- Este serviço é o único dono deste schema Postgres. Nenhuma migration deste
-- repositório deve tocar tabelas fora de "orders".
CREATE SCHEMA IF NOT EXISTS "orders";

-- CreateEnum
CREATE TYPE "orders"."OrderStatus" AS ENUM ('PENDING_PAYMENT', 'PAID', 'CANCELLED', 'FULFILLING', 'COMPLETED');

-- CreateEnum
CREATE TYPE "orders"."SellerOrderStatus" AS ENUM ('PENDING', 'CONFIRMED', 'PREPARING', 'SHIPPED', 'DELIVERED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "orders"."PaymentTransactionStatus" AS ENUM ('PENDING', 'APPROVED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "orders"."pedidos" (
    "id" UUID NOT NULL,
    "cliente_id" UUID NOT NULL,
    "numero_pedido" TEXT NOT NULL,
    "status" "orders"."OrderStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "subtotal_centavos" INTEGER NOT NULL,
    "frete_centavos" INTEGER NOT NULL DEFAULT 0,
    "desconto_centavos" INTEGER NOT NULL DEFAULT 0,
    "total_centavos" INTEGER NOT NULL,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pedidos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders"."enderecos_entrega_pedido" (
    "id" UUID NOT NULL,
    "pedido_id" UUID NOT NULL,
    "destinatario" TEXT NOT NULL,
    "logradouro" TEXT NOT NULL,
    "numero" TEXT NOT NULL,
    "complemento" TEXT,
    "bairro" TEXT NOT NULL,
    "cidade" TEXT NOT NULL,
    "estado" TEXT NOT NULL,
    "cep" TEXT NOT NULL,

    CONSTRAINT "enderecos_entrega_pedido_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders"."pedidos_vendedor" (
    "id" UUID NOT NULL,
    "pedido_id" UUID NOT NULL,
    "vendedor_id" UUID NOT NULL,
    "status" "orders"."SellerOrderStatus" NOT NULL DEFAULT 'PENDING',
    "subtotal_centavos" INTEGER NOT NULL,
    "frete_centavos" INTEGER NOT NULL DEFAULT 0,
    "comissao_centavos" INTEGER NOT NULL DEFAULT 0,
    "liquido_vendedor_centavos" INTEGER NOT NULL DEFAULT 0,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pedidos_vendedor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders"."itens_pedido" (
    "id" UUID NOT NULL,
    "pedido_vendedor_id" UUID NOT NULL,
    "produto_id" UUID NOT NULL,
    "variante_id" UUID NOT NULL,
    "titulo_produto" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "quantidade" INTEGER NOT NULL,
    "preco_unitario_centavos" INTEGER NOT NULL,
    "total_linha_centavos" INTEGER NOT NULL,

    CONSTRAINT "itens_pedido_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders"."transacoes_pagamento" (
    "id" UUID NOT NULL,
    "pedido_id" UUID NOT NULL,
    "status" "orders"."PaymentTransactionStatus" NOT NULL DEFAULT 'PENDING',
    "valor_centavos" INTEGER NOT NULL,
    "provedor" TEXT,
    "referencia_provedor" TEXT,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transacoes_pagamento_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pedidos_numero_pedido_key" ON "orders"."pedidos"("numero_pedido");

-- CreateIndex
CREATE INDEX "pedidos_cliente_id_idx" ON "orders"."pedidos"("cliente_id");

-- CreateIndex
CREATE INDEX "pedidos_status_idx" ON "orders"."pedidos"("status");

-- CreateIndex
CREATE INDEX "pedidos_criado_em_idx" ON "orders"."pedidos"("criado_em");

-- CreateIndex
CREATE UNIQUE INDEX "enderecos_entrega_pedido_pedido_id_key" ON "orders"."enderecos_entrega_pedido"("pedido_id");

-- CreateIndex
CREATE UNIQUE INDEX "pedidos_vendedor_pedido_id_vendedor_id_key" ON "orders"."pedidos_vendedor"("pedido_id", "vendedor_id");

-- CreateIndex
CREATE INDEX "pedidos_vendedor_pedido_id_idx" ON "orders"."pedidos_vendedor"("pedido_id");

-- CreateIndex
CREATE INDEX "pedidos_vendedor_vendedor_id_idx" ON "orders"."pedidos_vendedor"("vendedor_id");

-- CreateIndex
CREATE INDEX "pedidos_vendedor_status_idx" ON "orders"."pedidos_vendedor"("status");

-- CreateIndex
CREATE INDEX "itens_pedido_pedido_vendedor_id_idx" ON "orders"."itens_pedido"("pedido_vendedor_id");

-- CreateIndex
CREATE INDEX "itens_pedido_produto_id_idx" ON "orders"."itens_pedido"("produto_id");

-- CreateIndex
CREATE UNIQUE INDEX "transacoes_pagamento_provedor_referencia_provedor_key" ON "orders"."transacoes_pagamento"("provedor", "referencia_provedor");

-- CreateIndex
CREATE INDEX "transacoes_pagamento_pedido_id_idx" ON "orders"."transacoes_pagamento"("pedido_id");

-- CreateIndex
CREATE INDEX "transacoes_pagamento_status_idx" ON "orders"."transacoes_pagamento"("status");

-- AddForeignKey
ALTER TABLE "orders"."enderecos_entrega_pedido" ADD CONSTRAINT "enderecos_entrega_pedido_pedido_id_fkey" FOREIGN KEY ("pedido_id") REFERENCES "orders"."pedidos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders"."pedidos_vendedor" ADD CONSTRAINT "pedidos_vendedor_pedido_id_fkey" FOREIGN KEY ("pedido_id") REFERENCES "orders"."pedidos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders"."itens_pedido" ADD CONSTRAINT "itens_pedido_pedido_vendedor_id_fkey" FOREIGN KEY ("pedido_vendedor_id") REFERENCES "orders"."pedidos_vendedor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders"."transacoes_pagamento" ADD CONSTRAINT "transacoes_pagamento_pedido_id_fkey" FOREIGN KEY ("pedido_id") REFERENCES "orders"."pedidos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Nota: "cliente_id" (pedidos) é referência solta a identity.usuarios;
-- "vendedor_id" (pedidos_vendedor) e "produto_id"/"variante_id"
-- (itens_pedido) são referências soltas a catalog.produtos /
-- catalog.variantes_produto — sem FK cross-schema, mesma decisão já aplicada
-- em catalog-service e sellers-service. Integridade referencial é
-- responsabilidade da aplicação (CatalogServiceClient, resolvido por chamada
-- a catalog-service ANTES de qualquer linha ser gravada aqui), não do
-- Postgres — ver docs/internal-api-contract.md.

-- CheckConstraint
-- Mesmas regras do monólito de origem (migration
-- 20260901160000_check_financeiro_e_idempotencia_pagamento), adaptadas para
-- este schema.
ALTER TABLE "orders"."pedidos"
  ADD CONSTRAINT "pedidos_subtotal_centavos_nao_negativo_check"
  CHECK ("subtotal_centavos" >= 0);

ALTER TABLE "orders"."pedidos"
  ADD CONSTRAINT "pedidos_frete_centavos_nao_negativo_check"
  CHECK ("frete_centavos" >= 0);

ALTER TABLE "orders"."pedidos"
  ADD CONSTRAINT "pedidos_desconto_centavos_nao_negativo_check"
  CHECK ("desconto_centavos" >= 0);

ALTER TABLE "orders"."pedidos"
  ADD CONSTRAINT "pedidos_total_centavos_nao_negativo_check"
  CHECK ("total_centavos" >= 0);

ALTER TABLE "orders"."pedidos_vendedor"
  ADD CONSTRAINT "pedidos_vendedor_subtotal_centavos_nao_negativo_check"
  CHECK ("subtotal_centavos" >= 0);

ALTER TABLE "orders"."pedidos_vendedor"
  ADD CONSTRAINT "pedidos_vendedor_frete_centavos_nao_negativo_check"
  CHECK ("frete_centavos" >= 0);

ALTER TABLE "orders"."pedidos_vendedor"
  ADD CONSTRAINT "pedidos_vendedor_comissao_centavos_nao_negativo_check"
  CHECK ("comissao_centavos" >= 0);

ALTER TABLE "orders"."pedidos_vendedor"
  ADD CONSTRAINT "pedidos_vendedor_liquido_vendedor_centavos_nao_negativo_check"
  CHECK ("liquido_vendedor_centavos" >= 0);

ALTER TABLE "orders"."itens_pedido"
  ADD CONSTRAINT "itens_pedido_quantidade_positiva_check"
  CHECK ("quantidade" > 0);

ALTER TABLE "orders"."itens_pedido"
  ADD CONSTRAINT "itens_pedido_preco_unitario_centavos_nao_negativo_check"
  CHECK ("preco_unitario_centavos" >= 0);

ALTER TABLE "orders"."itens_pedido"
  ADD CONSTRAINT "itens_pedido_total_linha_centavos_nao_negativo_check"
  CHECK ("total_linha_centavos" >= 0);

ALTER TABLE "orders"."transacoes_pagamento"
  ADD CONSTRAINT "transacoes_pagamento_valor_centavos_positivo_check"
  CHECK ("valor_centavos" > 0);

ALTER TABLE "orders"."transacoes_pagamento"
  ADD CONSTRAINT "transacoes_pagamento_provedor_nao_vazio_check"
  CHECK ("provedor" IS NULL OR BTRIM("provedor") <> '');

ALTER TABLE "orders"."transacoes_pagamento"
  ADD CONSTRAINT "transacoes_pagamento_referencia_provedor_nao_vazia_check"
  CHECK ("referencia_provedor" IS NULL OR BTRIM("referencia_provedor") <> '');

ALTER TABLE "orders"."transacoes_pagamento"
  ADD CONSTRAINT "transacoes_pagamento_provedor_quando_referencia_check"
  CHECK ("referencia_provedor" IS NULL OR "provedor" IS NOT NULL);
