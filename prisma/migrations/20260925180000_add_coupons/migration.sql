-- CreateEnum
CREATE TYPE "orders"."CouponDiscountType" AS ENUM ('PERCENT', 'FIXED');

-- CreateTable
CREATE TABLE "orders"."cupons" (
    "id" UUID NOT NULL,
    "codigo" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "tipo_desconto" "orders"."CouponDiscountType" NOT NULL,
    "valor_desconto" INTEGER NOT NULL,
    "habilitado" BOOLEAN NOT NULL DEFAULT true,
    "comeca_em" TIMESTAMP(3) NOT NULL,
    "termina_em" TIMESTAMP(3) NOT NULL,
    "usos" INTEGER NOT NULL DEFAULT 0,
    "desconto_total_centavos" INTEGER NOT NULL DEFAULT 0,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cupons_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cupons_codigo_key" ON "orders"."cupons"("codigo");

-- CreateIndex
CREATE INDEX "cupons_habilitado_idx" ON "orders"."cupons"("habilitado");


-- AddCheckConstraint (hand-added -- Prisma schema syntax has no native CHECK support, same pattern as every other numeric CHECK in this project, ver avaliacoes_nota_check na migration 20260923190000_add_reviews)
ALTER TABLE "orders"."cupons" ADD CONSTRAINT "cupons_valor_desconto_check" CHECK ("valor_desconto" > 0);
ALTER TABLE "orders"."cupons" ADD CONSTRAINT "cupons_valor_desconto_percentual_check" CHECK ("tipo_desconto" <> 'PERCENT' OR "valor_desconto" <= 100);
ALTER TABLE "orders"."cupons" ADD CONSTRAINT "cupons_vigencia_check" CHECK ("termina_em" > "comeca_em");
