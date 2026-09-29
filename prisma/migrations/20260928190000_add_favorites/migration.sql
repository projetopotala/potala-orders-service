-- CreateTable
CREATE TABLE "orders"."favoritos" (
    "id" UUID NOT NULL,
    "cliente_id" UUID NOT NULL,
    "produto_id" UUID NOT NULL,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "favoritos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "favoritos_cliente_id_idx" ON "orders"."favoritos"("cliente_id");

-- CreateIndex
CREATE UNIQUE INDEX "favoritos_cliente_id_produto_id_key" ON "orders"."favoritos"("cliente_id", "produto_id");
