-- CreateEnum
CREATE TYPE "orders"."ReturnStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "orders"."devolucoes" (
    "id" UUID NOT NULL,
    "item_pedido_id" UUID NOT NULL,
    "cliente_id" UUID NOT NULL,
    "vendedor_id" UUID NOT NULL,
    "produto_id" UUID NOT NULL,
    "motivo" TEXT NOT NULL,
    "descricao" TEXT,
    "status" "orders"."ReturnStatus" NOT NULL DEFAULT 'REQUESTED',
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "devolucoes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "devolucoes_item_pedido_id_key" ON "orders"."devolucoes"("item_pedido_id");

-- CreateIndex
CREATE INDEX "devolucoes_cliente_id_idx" ON "orders"."devolucoes"("cliente_id");

-- CreateIndex
CREATE INDEX "devolucoes_vendedor_id_idx" ON "orders"."devolucoes"("vendedor_id");

-- CreateIndex
CREATE INDEX "devolucoes_status_idx" ON "orders"."devolucoes"("status");

-- AddForeignKey
ALTER TABLE "orders"."devolucoes" ADD CONSTRAINT "devolucoes_item_pedido_id_fkey" FOREIGN KEY ("item_pedido_id") REFERENCES "orders"."itens_pedido"("id") ON DELETE CASCADE ON UPDATE CASCADE;
