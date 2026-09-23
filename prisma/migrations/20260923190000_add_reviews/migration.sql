-- CreateTable
CREATE TABLE "orders"."avaliacoes" (
    "id" UUID NOT NULL,
    "item_pedido_id" UUID NOT NULL,
    "cliente_id" UUID NOT NULL,
    "vendedor_id" UUID NOT NULL,
    "produto_id" UUID NOT NULL,
    "nota" INTEGER NOT NULL,
    "comentario" TEXT,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "avaliacoes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "avaliacoes_item_pedido_id_key" ON "orders"."avaliacoes"("item_pedido_id");

-- CreateIndex
CREATE INDEX "avaliacoes_produto_id_idx" ON "orders"."avaliacoes"("produto_id");

-- CreateIndex
CREATE INDEX "avaliacoes_vendedor_id_idx" ON "orders"."avaliacoes"("vendedor_id");

-- AddForeignKey
ALTER TABLE "orders"."avaliacoes" ADD CONSTRAINT "avaliacoes_item_pedido_id_fkey" FOREIGN KEY ("item_pedido_id") REFERENCES "orders"."itens_pedido"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- AddCheckConstraint (hand-added -- Prisma schema syntax has no native CHECK support, same pattern as every other numeric CHECK in this project)
ALTER TABLE "orders"."avaliacoes" ADD CONSTRAINT "avaliacoes_nota_check" CHECK ("nota" BETWEEN 1 AND 5);
