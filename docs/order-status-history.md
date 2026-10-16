# F2.2A — Histórico persistente de status de pedidos

Tabela `orders.historico_status_pedido` (model `OrderStatusHistory`), migration `20261016180000_add_order_status_history`.

## 1. O que é registrado

Uma linha por **transição efetiva** de status de `Order` (pedido) ou `SellerOrder` (subpedido), e uma linha de **criação** de cada um (`status_anterior` NULL).

| Coluna | Conteúdo |
|---|---|
| `id` | identificador do evento (UUID) |
| `tipo_agregado` | `ORDER` ou `SELLER_ORDER` |
| `pedido_id` | pedido principal (sempre) |
| `pedido_vendedor_id`, `vendedor_id` | só em `SELLER_ORDER` (CHECK); `vendedor_id` é snapshot para filtrar por loja |
| `status_anterior`, `status_novo` | valores de `OrderStatus`/`SellerOrderStatus` (CHECK por agregado); nunca iguais |
| `origem` | `CHECKOUT`, `PAYMENT_CHECKOUT`, `PAYMENT_WEBHOOK`, `SELLER` |
| `tipo_ator`, `ator_id` | `CUSTOMER` (cliente do checkout), `SELLER` (usuário da loja), `SYSTEM` (o próprio serviço; `ator_id` NULL, nunca um humano inventado) |
| `correlacao_id` | reservado; NULL nesta versão (o gateway ainda não gera `x-request-id` e nenhum controller foi alterado para repassá-lo) |
| `motivo` | código fixo (CHECK `^[A-Z][A-Z0-9_]*$`): `INVENTORY_RESERVATION_FAILED`, `PAYMENT_DECLINED`, `PAYMENT_GATEWAY_UNAVAILABLE`, `PAYMENT_APPROVED` |
| `ocorrido_em` | `TIMESTAMP(3)` gravado pelo Prisma em UTC |

Não são gravados: mensagens de erro, payloads, endereço, e-mail, valores, chaves de idempotência ou tokens.

## 2. Como as transições são feitas (`OrderTransitionsService`)

```
dentro de uma transação interativa (sem chamada HTTP):
  updateMany({ where: { id, status: <esperado> }, data: { status: <novo> } })
  count === 1  ->  insere o evento  ->  true
  count === 0  ->  nada é gravado   ->  false (quem chama decide: 409 ou no-op)
```

- Status e evento entram ou saem juntos (rollback conjunto).
- Repetição ou corrida que não muda o status não gera evento.
- Subpedidos: o UPDATE é escopado a `id + pedido_id + vendedor_id + status`.
- Transição coletiva de subpedidos (confirmar/cancelar junto com o pedido) é **tudo ou nada**:
  - antes de mudar o pedido, verifica-se na mesma transação que **todos** os subpedidos estão `PENDING`; se não estiverem, nada muda (nem pedido, nem subpedidos) e o fato é logado;
  - se um subpedido mudar entre a verificação e o UPDATE condicional (corrida), a transação inteira é desfeita (`SellerOrdersStateConflictError`).
  - Nunca existe pedido `PAID`/`CANCELLED` com subpedido em estado incompatível deixado para trás.

| Ponto | Transição | Origem / ator |
|---|---|---|
| `insertOrder` (checkout) | criação do pedido (`PENDING_PAYMENT`) e de cada subpedido (`PENDING`) | `CHECKOUT` / `CUSTOMER` |
| falha da reserva no checkout | pedido `PENDING_PAYMENT → CANCELLED`, subpedidos `PENDING → CANCELLED` | `CHECKOUT` / `SYSTEM` |
| pagamento aprovado | transação `PENDING → APPROVED`, pedido `→ PAID`, subpedidos `PENDING → CONFIRMED` | `PAYMENT_CHECKOUT` ou `PAYMENT_WEBHOOK` / `SYSTEM` |
| pagamento recusado / gateway indisponível | transação `PENDING → FAILED`, pedido `→ CANCELLED`, subpedidos `PENDING → CANCELLED` | idem |
| vendedor: preparar / enviar / entregar | `CONFIRMED → PREPARING → SHIPPED → DELIVERED` | `SELLER` / `SELLER` (usuário da loja) |

O vendedor continua sem poder confirmar manualmente (`PATCH /seller/orders/:id/confirm` sempre 409).

## 3. Mudanças de comportamento

1. **Cancelamento consistente (D-A1):** nas falhas internas do checkout/pagamento, os subpedidos (todos `PENDING`) passam para `CANCELLED` junto com o pedido. Antes ficavam `PENDING`. Se algum subpedido não estiver `PENDING` (estado inesperado), o pedido **não** é cancelado: subpedidos confirmados, enviados ou entregues nunca são tocados nem ficam presos a um pedido cancelado. O frontend já rotula `CANCELLED` em subpedido.
2. **Pagamento condicionado (D-A2):**
   - aprovação/recusa só é aplicada se a transação ainda está `PENDING`; webhook repetido ou concorrente vira no-op e **não** chama `commitInventory`/`releaseInventory` de novo;
   - aprovação para pedido que já não está `PENDING_PAYMENT`, ou com algum subpedido fora de `PENDING`, **nunca** o transforma em `PAID`: a transação registra o fato do provedor (`APPROVED`, com `provider`/`providerRef`), pedido e subpedidos ficam como estão, nenhum estoque é baixado e um erro é logado. Detectável por SQL — tratamento na F2.2C:

     ```sql
     SELECT t.id, t.pedido_id, t.provedor, t.referencia_provedor, p.status
       FROM orders.transacoes_pagamento t
       JOIN orders.pedidos p ON p.id = t.pedido_id
      WHERE t.status = 'APPROVED' AND p.status <> 'PAID';
     ```
3. Contratos HTTP inalterados (mesmos status, mensagens e corpos).

## 4. Lacunas conhecidas (dependências F2.2B/C/D)

1. **Pagamento aprovado e estoque não baixado.** Sequência: transação `APPROVED` + pedido `PAID` + subpedidos `CONFIRMED` são confirmados no banco; depois `commitInventory` falha (ou o serviço cai antes de chamá-lo).
   - Estado que permanece: `APPROVED` / `PAID` / `CONFIRMED`, com histórico; no catálogo o estoque fica **reservado e não baixado**.
   - Webhook repetido: a transação já não está `PENDING`, então é no-op — **nenhuma operação externa é repetida** (nem commit, nem transição). No checkout síncrono, o retry com a mesma chave (F2.1) recebe o pedido `PAID` em replay, também sem repetir nada.
   - **Não há marcador persistido** de que o commit falhou: o caso não é localizável por SQL, só pelo log `commitInventory failed for order ...`.
   - Não se repete `commitInventory` automaticamente porque o catálogo não é idempotente por pedido (contadores agregados): repetir poderia baixar o estoque duas vezes.
   - Dependências: marcador de estoque no pedido (F2.2C), ledger de reservas por pedido no catálogo (F2.2D), comando de commit idempotente via outbox (F2.2B).
2. **Pagamento assíncrono (`PENDING`) não grava `provider`/`providerRef` no checkout.** O webhook localiza a transação por `(provider, providerRef)`; como esses campos ficam nulos no ramo `PENDING`, um webhook real não encontraria a transação e seria ignorado. É anterior à F2.2A e latente (o mock sempre aprova de forma síncrona), mas precisa ser corrigido antes de qualquer provedor real (D-03). Não alterado nesta rodada (lógica financeira).
3. Falha de banco na própria transação de finalização (rara) desfaz tudo, inclusive `provider`/`providerRef` da aprovação — mesma lacuna já registrada no diagnóstico F2.2 (E5).

## 5. Retenção, exclusão e histórico anterior

- Append-only; sem limpeza automática (retenção indefinida até decisão da F2.2B/C).
- FKs `ON DELETE RESTRICT`: excluir fisicamente um pedido ou subpedido com histórico falha em vez de apagar o histórico.
- **O histórico começa na ativação da migration.** Pedidos anteriores não têm eventos; nenhum evento passado é inventado (sem backfill).

## 6. Validação

- Testes mockados: `order-status-history.spec.ts`, além de `orders.service.spec.ts` e `orders.checkout-idempotency.spec.ts` (F2.1 + histórico). Provam a orquestração, **não** a atomicidade real do PostgreSQL.
- Pendente de homologação isolada: aplicar a migration em banco descartável, conferir `prisma migrate diff` (diferença esperada: só os CHECKs) e provar a corrida real (duas transações concorrentes no mesmo status: uma `count 1`, outra `count 0`).
- **Não aplicar no Supabase compartilhado.** Aplicar a migration **antes** do deploy do código (o Render publica a `main` automaticamente).
