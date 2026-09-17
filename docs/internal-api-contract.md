# Contrato interno — orders-service

Este serviço é **sempre cliente**, nunca callee, de rotas `/internal/*`.
Não expõe nenhuma rota interna própria nesta v1 — nenhum outro serviço
chama orders-service (o roteamento em `potala-api-gateway` para
`/api/v1/orders/*` é tráfego de navegador, sempre autenticado por sessão,
nunca `x-internal-api-key`).

## O que este serviço espera que **identity-service** exponha (já existe)

### `POST /api/v1/internal/sessions/introspect`

Usado por `SessionAuthGuard` (via `IdentityServiceClient.introspectSession`)
em toda requisição autenticada — hoje, todo o grupo `/orders*`. Este serviço
lê o cookie de sessão (`SESSION_COOKIE_NAME`, deve ser o mesmo nome
configurado em identity-service) diretamente da requisição — ainda não
existe api-gateway repassando um header de identidade confiável — e manda o
valor cru para este endpoint a cada request. `401` do lado de
identity-service vira `401` aqui; qualquer outro status inesperado vira
`503` (nunca é tratado como "não autenticado"). Mesmo padrão dos quatro
serviços anteriores.

## O que este serviço espera que **catalog-service** exponha (já existe)

Adicionado a catalog-service especificamente para este serviço — ver o
`docs/internal-api-contract.md` de catalog-service para o lado que expõe.

### `POST /api/v1/internal/product-variants/resolve`

Body: `{ "variantIds": ["uuid", ...] }` (deduplicado antes do envio — ver
`resolveAndValidateItems` em `orders.service.ts`). Usado no início de todo
`checkout`, uma única chamada em lote para todas as linhas do carrinho.
Resposta:

```json
[
  {
    "variantId": "uuid",
    "productId": "uuid",
    "sellerId": "uuid",
    "productStatus": "DRAFT" | "REVIEW" | "ACTIVE" | "REJECTED" | "INACTIVE",
    "productTitle": "string",
    "sku": "string",
    "variantName": "string",
    "unitPriceCents": 1234,
    "availableQuantity": 10
  }
]
```

Cada linha do carrinho enviado pelo cliente é validada contra a resposta,
**nunca** contra o próprio corpo da requisição:

1. `variantId` precisa aparecer na resposta — um id ausente vira `400`
   (o cliente mandou uma variante que não existe, ou que catalog-service
   decidiu não resolver).
2. `productId` da linha precisa bater com o `productId` que catalog-service
   resolveu para aquele `variantId` — um `400` se não bater (o cliente
   mandou um par produto/variante inconsistente).
3. `productStatus` precisa ser `ACTIVE` — qualquer outro status vira `400`
   ("produto não disponível para compra").
4. `availableQuantity` precisa ser >= à quantidade pedida — checagem
   **antecipada e não-atômica**, só para dar um erro rápido e claro
   (`409`); a checagem autoritativa e atômica é a chamada de `reserve`
   abaixo — estoque pode mudar entre esta checagem e aquela chamada.

`unitPriceCents` e `sellerId` vindos desta resposta — nunca do corpo da
requisição de checkout — são o que fica gravado em `OrderItem`/`SellerOrder`.

### `POST /api/v1/internal/inventory/reserve|release|commit`

Body para os três: `{ "items": [{ "variantId": "uuid", "quantity": 1 }, ...] }`.
Cada chamada é tudo-ou-nada no lado de catalog-service (uma única transação
Postgres cobrindo o lote inteiro) — o que permite a este serviço tratar
"reservar os itens de um pedido" como uma única operação, sem implementar
sua própria compensação item-a-item para esta chamada especificamente.

Uso em `OrdersService.checkout`:

- `reserve`: chamado **depois** que `Order`/`SellerOrder`/`OrderItem` já
  foram criados localmente (transação curta, já fechada) e **antes** de
  chamar o gateway de pagamento — nunca dentro de uma transação Postgres
  aberta (ver README.md, "Por que uma transação Postgres nunca fica aberta
  esperando uma chamada de rede"). Falha (ex: `409 Insufficient stock`) →
  o pedido local é marcado `CANCELLED` e o erro original é propagado ao
  cliente; nenhuma cobrança é tentada.
- `commit`: chamado depois que o gateway de pagamento aprova a cobrança —
  transforma a reserva em estoque consumido. Uma falha aqui **não** desfaz
  o pagamento já aprovado nem o `Order` já marcado `PAID` — é só logada.
  Ver "Gaps conhecidos" abaixo.
- `release`: chamado quando o gateway de pagamento recusa ou está
  inacessível — desfaz a reserva feita acima. Também só logada em caso de
  falha.

## Gaps conhecidos — não resolvidos especulativamente

- **Sem idempotência por pedido**: nenhuma das três chamadas acima carrega
  uma chave de idempotência própria (ex: `orderId`). Uma repetição de rede
  (timeout no lado de orders-service, catalog-service processou mas a
  resposta se perdeu) pode reservar/liberar/comprometer o mesmo lote duas
  vezes.
- **Sem reconciliação em segundo plano**: se `commit` ou `release` falhar
  depois que a decisão de pagamento (aprovado/recusado) já foi persistida
  localmente em `Order`/`PaymentTransaction`, o único registro do problema é
  a linha de log (`this.logger.error(...)` em `finalizeApprovedPayment`/
  `finalizeFailedPayment`). Não há job de retry, fila, nem alerta
  automático — reconciliar um caso desses hoje é manual (comparar o status
  do `Order` aqui com o estado de `Inventory` em catalog-service).
- **Sem idempotência de checkout em si**: dois `POST /orders/checkout`
  idênticos (duplo-clique, retry de rede do lado do cliente) criam dois
  pedidos distintos — dois `orderNumber`, duas reservas, potencialmente duas
  cobranças (mock, sempre aprova) contra o mesmo carrinho.

Nenhum destes é resolvido nesta v1 — documentado aqui e no README para que
a próxima pessoa a mexer neste serviço não presuma uma garantia que não
existe.

## Timeouts e resiliência

`IDENTITY_SERVICE_TIMEOUT_MS` e `CATALOG_SERVICE_TIMEOUT_MS` (default 5000ms
cada) limitam quanto tempo este serviço espera por cada dependência antes de
abortar (`AbortController`, erro de rede vira `503`). As duas são
obrigatórias: não existe rota autenticada neste serviço capaz de responder
sem identity-service no ar, e checkout especificamente não consegue validar
nem uma única linha de carrinho sem catalog-service no ar.

## Por que este serviço não tem grupo de throttle `internal`

Diferente de identity-service, sellers-service e catalog-service, este
serviço não expõe nenhuma rota `/internal/*` própria — só o grupo `default`
existe aqui (ver `app.module.ts`). O dia em que outro serviço precisar
chamar orders-service (ex: um futuro serviço de fulfillment lendo
`SellerOrder`s), esta seção — e um segundo grupo de throttle — precisam ser
adicionados, seguindo o mesmo padrão que catalog-service ganhou para atender
este serviço.
