-- ============================================================================
-- Fundação do pós-venda (Fase E) -- reclamações, disputas, logística reversa.
--
-- ESCRITA À MÃO originalmente: o `prisma` CLI (schema-engine) não conseguiu
-- rodar nesta ponte (download do engine Linux bloqueado -- 403 em
-- binaries.prisma.sh; só existe o engine Windows em node_modules).
--
-- REVISADA (07/10) contra o SQL oficial gerado por Prisma 6.19.3 no
-- Windows do Arthur. Um achado real foi corrigido: as FKs opcionais de
-- "orders"."disputas" (reclamacao_id/devolucao_id) usavam ON DELETE SET
-- NULL -- incompatível com disputas_origem_unica_check (poderia deixar as
-- duas colunas NULL ao mesmo tempo, violando o CHECK). Corrigido para
-- RESTRICT (ver comentário acima de cada ALTER TABLE abaixo). A revisão
-- também confirmou um drift pré-existente e não relacionado: o schema já
-- tem o model Favorite, mas o banco real aparentemente não -- isso fica
-- de fora desta migration de propósito, a ser investigado separadamente
-- (não é um achado desta rodada do pós-venda).
--
-- Claim.returnId continua ON DELETE SET NULL (não revisitado por
-- instrução explícita -- não há CHECK em Claim exigindo returnId).
-- Nenhuma outra ação de ON DELETE deste arquivo foi alterada na revisão.
-- ============================================================================

-- AlterEnum (aditivo -- nenhum valor existente de ReturnStatus foi removido
-- ou renomeado; linhas já gravadas continuam válidas sem backfill)
ALTER TYPE "orders"."ReturnStatus" ADD VALUE 'AWAITING_SHIPMENT';
ALTER TYPE "orders"."ReturnStatus" ADD VALUE 'SHIPPED';
ALTER TYPE "orders"."ReturnStatus" ADD VALUE 'RECEIVED';
ALTER TYPE "orders"."ReturnStatus" ADD VALUE 'UNDER_REVIEW';
ALTER TYPE "orders"."ReturnStatus" ADD VALUE 'COMPLETED';
ALTER TYPE "orders"."ReturnStatus" ADD VALUE 'CONTESTED';
ALTER TYPE "orders"."ReturnStatus" ADD VALUE 'CANCELLED';

-- CreateEnum
CREATE TYPE "orders"."ClaimStatus" AS ENUM ('OPEN', 'SELLER_RESPONSE_REQUIRED', 'CUSTOMER_RESPONSE_REQUIRED', 'RESOLVED', 'ESCALATED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "orders"."ClaimAuthorRole" AS ENUM ('CUSTOMER', 'SELLER', 'ADMIN');

-- CreateEnum
CREATE TYPE "orders"."DisputeStatus" AS ENUM ('OPEN', 'UNDER_REVIEW', 'WAITING_CUSTOMER', 'WAITING_SELLER', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "orders"."DisputeOutcome" AS ENUM ('CUSTOMER_FAVORED', 'SELLER_FAVORED', 'PARTIAL', 'NO_ACTION');

-- CreateEnum
CREATE TYPE "orders"."ReturnShipmentStatus" AS ENUM ('PENDING', 'POSTED', 'RECEIVED', 'LOST');

-- AlterTable (Return -- novas colunas nullable, zero impacto em linha existente)
ALTER TABLE "orders"."devolucoes" ADD COLUMN "notas_condicao_recebimento" TEXT,
ADD COLUMN "revisado_por_usuario_id" UUID;

-- CreateTable
CREATE TABLE "orders"."reclamacoes" (
    "id" UUID NOT NULL,
    "pedido_id" UUID NOT NULL,
    "pedido_vendedor_id" UUID NOT NULL,
    "item_pedido_id" UUID NOT NULL,
    "cliente_id" UUID NOT NULL,
    "vendedor_id" UUID NOT NULL,
    "motivo" TEXT NOT NULL,
    "descricao" TEXT,
    "status" "orders"."ClaimStatus" NOT NULL DEFAULT 'OPEN',
    "devolucao_id" UUID,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMP(3) NOT NULL,
    "resolvido_em" TIMESTAMP(3),

    CONSTRAINT "reclamacoes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders"."reclamacao_mensagens" (
    "id" UUID NOT NULL,
    "reclamacao_id" UUID NOT NULL,
    "autor_usuario_id" UUID NOT NULL,
    "autor_papel" "orders"."ClaimAuthorRole" NOT NULL,
    "mensagem" TEXT NOT NULL,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reclamacao_mensagens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders"."reclamacao_evidencias" (
    "id" UUID NOT NULL,
    "reclamacao_id" UUID NOT NULL,
    "enviado_por_usuario_id" UUID NOT NULL,
    "enviado_por_papel" "orders"."ClaimAuthorRole" NOT NULL,
    "chave_armazenamento" TEXT NOT NULL,
    "nome_arquivo" TEXT NOT NULL,
    "tipo_mime" TEXT NOT NULL,
    "tamanho_bytes" INTEGER NOT NULL,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reclamacao_evidencias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders"."devolucao_envios" (
    "id" UUID NOT NULL,
    "devolucao_id" UUID NOT NULL,
    "transportadora" TEXT,
    "codigo_rastreio" TEXT,
    "status" "orders"."ReturnShipmentStatus" NOT NULL DEFAULT 'PENDING',
    "postado_em" TIMESTAMP(3),
    "recebido_em" TIMESTAMP(3),
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "devolucao_envios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders"."disputas" (
    "id" UUID NOT NULL,
    "reclamacao_id" UUID,
    "devolucao_id" UUID,
    "status" "orders"."DisputeStatus" NOT NULL DEFAULT 'OPEN',
    "outcome" "orders"."DisputeOutcome",
    "aberta_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvida_em" TIMESTAMP(3),
    "fechada_em" TIMESTAMP(3),

    CONSTRAINT "disputas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders"."decisoes_disputa" (
    "id" UUID NOT NULL,
    "disputa_id" UUID NOT NULL,
    "decidido_por_usuario_id" UUID NOT NULL,
    "outcome" "orders"."DisputeOutcome" NOT NULL,
    "motivo" TEXT NOT NULL,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "decisoes_disputa_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reclamacoes_devolucao_id_key" ON "orders"."reclamacoes"("devolucao_id");

-- CreateIndex
CREATE INDEX "reclamacoes_cliente_id_idx" ON "orders"."reclamacoes"("cliente_id");

-- CreateIndex
CREATE INDEX "reclamacoes_vendedor_id_idx" ON "orders"."reclamacoes"("vendedor_id");

-- CreateIndex
CREATE INDEX "reclamacoes_pedido_id_idx" ON "orders"."reclamacoes"("pedido_id");

-- CreateIndex
CREATE INDEX "reclamacoes_pedido_vendedor_id_idx" ON "orders"."reclamacoes"("pedido_vendedor_id");

-- CreateIndex
CREATE INDEX "reclamacoes_item_pedido_id_idx" ON "orders"."reclamacoes"("item_pedido_id");

-- CreateIndex
CREATE INDEX "reclamacoes_status_idx" ON "orders"."reclamacoes"("status");

-- CreateIndex
CREATE INDEX "reclamacao_mensagens_reclamacao_id_idx" ON "orders"."reclamacao_mensagens"("reclamacao_id");

-- CreateIndex
CREATE INDEX "reclamacao_evidencias_reclamacao_id_idx" ON "orders"."reclamacao_evidencias"("reclamacao_id");

-- CreateIndex
CREATE INDEX "devolucao_envios_devolucao_id_idx" ON "orders"."devolucao_envios"("devolucao_id");

-- CreateIndex
CREATE INDEX "devolucao_envios_status_idx" ON "orders"."devolucao_envios"("status");

-- CreateIndex
CREATE UNIQUE INDEX "disputas_reclamacao_id_key" ON "orders"."disputas"("reclamacao_id");

-- CreateIndex
CREATE UNIQUE INDEX "disputas_devolucao_id_key" ON "orders"."disputas"("devolucao_id");

-- CreateIndex
CREATE INDEX "disputas_status_idx" ON "orders"."disputas"("status");

-- CreateIndex
CREATE INDEX "decisoes_disputa_disputa_id_idx" ON "orders"."decisoes_disputa"("disputa_id");

-- AddForeignKey
ALTER TABLE "orders"."reclamacoes" ADD CONSTRAINT "reclamacoes_pedido_id_fkey" FOREIGN KEY ("pedido_id") REFERENCES "orders"."pedidos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders"."reclamacoes" ADD CONSTRAINT "reclamacoes_pedido_vendedor_id_fkey" FOREIGN KEY ("pedido_vendedor_id") REFERENCES "orders"."pedidos_vendedor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders"."reclamacoes" ADD CONSTRAINT "reclamacoes_item_pedido_id_fkey" FOREIGN KEY ("item_pedido_id") REFERENCES "orders"."itens_pedido"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders"."reclamacoes" ADD CONSTRAINT "reclamacoes_devolucao_id_fkey" FOREIGN KEY ("devolucao_id") REFERENCES "orders"."devolucoes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders"."reclamacao_mensagens" ADD CONSTRAINT "reclamacao_mensagens_reclamacao_id_fkey" FOREIGN KEY ("reclamacao_id") REFERENCES "orders"."reclamacoes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders"."reclamacao_evidencias" ADD CONSTRAINT "reclamacao_evidencias_reclamacao_id_fkey" FOREIGN KEY ("reclamacao_id") REFERENCES "orders"."reclamacoes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders"."devolucao_envios" ADD CONSTRAINT "devolucao_envios_devolucao_id_fkey" FOREIGN KEY ("devolucao_id") REFERENCES "orders"."devolucoes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- RESTRICT, nao SET NULL: achado na revisao contra o SQL oficial do Prisma
-- 6.19.3 (Windows) -- SET NULL permitiria apagar a Claim/Return de origem
-- e deixar reclamacao_id=NULL e devolucao_id=NULL ao mesmo tempo, violando
-- o disputas_origem_unica_check abaixo (exige exatamente uma origem).
-- Restrict tambem preserva historico/auditoria -- a origem de uma disputa
-- existente nunca pode ser apagada.
ALTER TABLE "orders"."disputas" ADD CONSTRAINT "disputas_reclamacao_id_fkey" FOREIGN KEY ("reclamacao_id") REFERENCES "orders"."reclamacoes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders"."disputas" ADD CONSTRAINT "disputas_devolucao_id_fkey" FOREIGN KEY ("devolucao_id") REFERENCES "orders"."devolucoes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders"."decisoes_disputa" ADD CONSTRAINT "decisoes_disputa_disputa_id_fkey" FOREIGN KEY ("disputa_id") REFERENCES "orders"."disputas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddCheckConstraint (hand-added -- Prisma schema syntax has no native CHECK support, mesmo padrão de todo CHECK deste projeto)
ALTER TABLE "orders"."reclamacao_evidencias" ADD CONSTRAINT "reclamacao_evidencias_tamanho_bytes_check" CHECK ("tamanho_bytes" > 0);
ALTER TABLE "orders"."reclamacao_evidencias" ADD CONSTRAINT "reclamacao_evidencias_nome_arquivo_check" CHECK (BTRIM("nome_arquivo") <> '');
ALTER TABLE "orders"."reclamacao_evidencias" ADD CONSTRAINT "reclamacao_evidencias_chave_armazenamento_check" CHECK (BTRIM("chave_armazenamento") <> '');
ALTER TABLE "orders"."reclamacao_evidencias" ADD CONSTRAINT "reclamacao_evidencias_tipo_mime_check" CHECK (BTRIM("tipo_mime") <> '');

-- Exatamente um de reclamacao_id/devolucao_id precisa estar preenchido --
-- uma Dispute nunca nasce "do nada" nem das duas origens ao mesmo tempo.
ALTER TABLE "orders"."disputas" ADD CONSTRAINT "disputas_origem_unica_check" CHECK ((("reclamacao_id" IS NOT NULL)::int + ("devolucao_id" IS NOT NULL)::int) = 1);
