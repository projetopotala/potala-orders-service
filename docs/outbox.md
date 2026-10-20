# F2.2B-A — Outbox transacional (somente persistência)

Tabela `orders.eventos_outbox` (model `OutboxEvent`), migration `20261017120000_add_outbox_events`.

**Nesta entrega não existe publicador:**
- nenhum worker, cron, timer, endpoint de despacho ou chamada HTTP;
- os eventos só são gravados e ficam `PENDING`;
- há um teste estático que falha se o código de produção ler, atualizar ou apagar a outbox, ou criar timer/agendamento/publicador.

## 1. Contratos (versão 1)

| `tipo_evento` | Agregado (`agregado_id`) | Payload v1 |
|---|---|---|
| `orders.order.created` | `ORDER` (pedido) | `orderId`, `status`, `source` |
| `orders.order.status_changed` | `ORDER` | `orderId`, `fromStatus`, `toStatus`, `source`, `reason` |
| `orders.seller_order.created` | `SELLER_ORDER` (subpedido) | `orderId`, `sellerOrderId`, `sellerId`, `status`, `source` |
| `orders.seller_order.status_changed` | `SELLER_ORDER` | `orderId`, `sellerOrderId`, `sellerId`, `fromStatus`, `toStatus`, `source`, `reason` |

- Os nomes são estáveis. Uma mudança incompatível de payload gera nova `versao_evento`, nunca uma alteração da atual.
- `source`: `CHECKOUT`, `PAYMENT_CHECKOUT`, `PAYMENT_WEBHOOK`, `SELLER`.
- `reason`: o mesmo código fixo do histórico (`INVENTORY_RESERVATION_FAILED`, `PAYMENT_DECLINED`, `PAYMENT_GATEWAY_UNAVAILABLE`, `PAYMENT_APPROVED`) ou `null`.
- **Fica fora do payload:** endereço, e-mail, nome, ator humano (`ator_id`), cliente, valores, itens, referência de provedor, chave de idempotência, mensagens de erro.
- `PAYMENT_APPROVED` diz que o pagamento foi aprovado. **Não** diz que o estoque foi baixado: a baixa no catálogo é operação externa, com resultado só logado.
- Com o gateway indisponível (resultado desconhecido), o evento é só o cancelamento do pedido com o motivo; **não existe** evento de "pagamento recusado".
- Eventos próprios de `PaymentTransaction` (aprovação, recusa, anomalias) ficam fora desta entrega. São dependência da reconciliação (F2.2C) e do financeiro (F3).

## 2. Gravação atômica

`OrderTransitionsService.appendHistory` é a única gravação de histórico. No **mesmo `tx`**:

1. Faz o INSERT no histórico com `id` gerado na aplicação.
2. Faz o INSERT do evento com `id` (eventId) **novo** e `historico_id` = id do histórico (UNIQUE).

| Situação | Efeito |
|---|---|
| Criação de pedido/subpedido | Os dois INSERTs acontecem na transação de criação do checkout (com cupom e `attachOrder` da F2.1) |
| Transição | Os dois INSERTs só acontecem depois de o UPDATE condicional acertar a linha. `count 0` não gera histórico nem evento |
| Falha em qualquer INSERT, `attachOrder`, `SellerOrdersStateConflictError` | Rollback de status, histórico e evento juntos |
| Chamadas HTTP (catálogo, gateway) | Continuam fora das transições |

## 3. Deduplicação

| Mecanismo | Garantia |
|---|---|
| UPDATE condicional (F2.2A) | Repetição, corrida ou transição inválida não produzem histórico, então não produzem evento |
| `historico_id` UNIQUE | No máximo um evento por linha de histórico |
| `id` (eventId) PK | Identificador que os consumidores futuros usarão para deduplicar (inbox) |
| Replays da F2.1 | Não executam o checkout, então não geram nada |

## 4. Ordenação: garantias e limites

- **`sequencia` (identity) é a ordem de inserção.** Não representa a ordem global dos commits: uma transação pode obter um número menor e confirmar depois.
- **`ocorrido_em` é o horário de início da transação** (`CURRENT_TIMESTAMP`). Eventos da mesma transação têm o mesmo horário.
- **Garantia real: ordem dentro de um mesmo agregado.**
  - Toda transição grava o evento **depois** do UPDATE condicional, que bloqueia a linha do pedido ou do subpedido até o commit.
  - Duas transações do mesmo agregado se serializam nesse lock, então a segunda só obtém sua `sequencia` depois do commit da primeira.
  - A criação acontece na transação que insere a linha.
- **Sem garantia** entre agregados diferentes, nem entre o pedido e seus subpedidos de transações distintas.

## 5. Entrega futura (F2.2B-B)

- Será **pelo menos uma vez**: os consumidores precisarão ser idempotentes (inbox por `id`). Não há entrega exatamente uma vez entre serviços.
- As colunas `tentativas`, `proxima_tentativa_em`, `bloqueado_ate`, `token_processamento`, `ultimo_erro`, `publicado_em` e os estados `PROCESSING`/`PUBLISHED`/`FAILED` já existem para essa etapa. Nesta entrega ficam nos defaults.

## 6. Retenção

- Sem expurgo automático nesta entrega. Volume esperado: cerca de 3 a 8 linhas por pedido.
- Proposta para depois da F2.2B-B: expurgar `PUBLISHED` com mais de 30–90 dias, por job aprovado (é delete físico).
- `PENDING`/`FAILED` nunca serão expurgados automaticamente.
- FKs `RESTRICT`: excluir um pedido ou uma linha de histórico com eventos falha em vez de apagá-los.
- Sem backfill: pedidos anteriores à ativação não têm eventos.

## 7. Validação

- Os testes Jest usam bancos simulados (mock, MemoryDb, FakeDb). Provam a **orquestração** (quem grava, quando, quantos, o que é desfeito), **não** a atomicidade real do PostgreSQL.
- **Pendente em homologação isolada:**
  - aplicar as migrations F2.1 → F2.2A → F2.2B-A do zero em banco descartável;
  - `prisma migrate diff` (diferença esperada: só os CHECKs);
  - provar rollback real e a ordem por agregado sob concorrência.
- **Não aplicar no Supabase compartilhado.** Aplicar a migration **antes** do deploy do código (o Render publica a `main` automaticamente).
