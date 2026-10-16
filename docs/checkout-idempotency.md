# F2.1 — Idempotência do checkout (`POST /api/v1/orders/checkout`)

Objetivo: uma repetição do mesmo checkout (duplo clique, retry de rede,
timeout do gateway, reenvio do navegador) **nunca cria um segundo pedido**
nem repete reserva de estoque ou cobrança.

## 1. Contrato HTTP

| Requisição | Resultado |
|---|---|
| Sem `Idempotency-Key` | Comportamento anterior, sem proteção: cada chamada é um pedido novo |
| `Idempotency-Key` inválida (fora de `^[A-Za-z0-9._:-]{16,128}$`, inclusive dois valores unidos por `, `) | **400**, nada é gravado nem consultado |
| Chave nova | Executa o checkout normalmente (**201**, mesmo corpo de antes) |
| Mesma chave + mesmo payload, pedido já concluído | **201** com o pedido existente (estado atual) + `Idempotent-Replayed: true`; sem nova reserva nem cobrança |
| Mesma chave + mesmo payload, tentativa ainda em andamento | **409** "already in progress" — repetir a mesma requisição em instantes |
| Mesma chave + mesmo payload, tentativa terminou em erro **HTTP** depois de o pedido existir (reserva ou pagamento; pedido já `CANCELLED`) | Mesmo status e corpo do erro original + `Idempotent-Replayed: true`; para comprar de novo, nova chave |
| Mesma chave + mesmo payload, tentativa terminou em erro **inesperado** (não HTTP: Prisma, rede, bug) depois de o pedido existir | Resultado incerto: nada terminal é gravado. O retry seguinte recebe **201 com o pedido no estado real** (`PAID`, `PENDING_PAYMENT` ou `CANCELLED`) + `Idempotent-Replayed: true`; nada é reexecutado |
| Mesma chave + mesmo payload, tentativa terminou em erro **antes** de o pedido existir | A chave foi liberada: a requisição é executada de novo |
| Mesma chave + payload **diferente** | **422**; nada é criado |
| Mesma chave usada por **outro cliente** | Independente (a chave pertence ao par cliente + chave) |

- A chave é sempre associada ao usuário da **sessão** (`SessionAuthGuard`), nunca a um id do corpo (o `ValidationPipe` recusa campos extras).
- Payload comparado: SHA-256 de uma forma canônica de `items` (ordem das linhas ignorada), `shippingAddress` e `couponCode` (trim + maiúsculas), depois do `ValidationPipe`.
- `Idempotent-Replayed` não é exposto ao JavaScript do navegador pelo CORS do gateway (`exposedHeaders` não configurado). O frontend decide só pelo status; o header serve para logs, testes e clientes servidor-a-servidor.
- Autorização inalterada: checkout continua `@Roles(CUSTOMER)` nesta base (vendedor que compra depende de D-16, `fix/seller-checkout`).

## 2. Funcionamento (`CheckoutIdempotencyService`)

Tabela `orders.chaves_idempotencia_checkout`, migration `20261015180000_add_checkout_idempotency` (aditiva, só schema `orders`).

1. **Reivindicação atômica.** `createMany({ skipDuplicates: true })` gera `INSERT … ON CONFLICT DO NOTHING` sobre `UNIQUE (cliente_id, chave)`. Só uma requisição concorrente insere; as demais leem a linha existente. Funciona com várias instâncias do serviço (nada em memória).
2. **Sem transação aberta durante HTTP.** Resolução no catalog-service, reserva de estoque e cobrança continuam fora de transações, como antes. A única transação é a que já existia para gravar `Order`/`SellerOrder`/`OrderItem`/uso de cupom.
3. **Vínculo atômico.** Dentro dessa mesma transação, `attachOrder` faz `UPDATE … SET pedido_id WHERE token_execucao = <meu token> AND pedido_id IS NULL`. Se outra execução retomou a chave, 0 linhas → exceção → a transação inteira (pedido, subpedidos, itens, uso de cupom) é desfeita.
4. **Recuperação.**
   - Antes de o pedido existir, a posse vale `CHECKOUT_IDEMPOTENCY_LEASE_MS` (60 s). Vencida (processo caiu), um retry retoma com `UPDATE` condicional ao token antigo; só um retry concorrente vence.
   - Depois que o pedido existe, a chave **nunca** é reexecutada: o retry recebe o pedido como ficou.
   - Falha antes do pedido: a chave é apagada (`DELETE … WHERE token = <meu> AND pedido_id IS NULL`) e o mesmo request pode ser repetido.
5. **Erro inesperado depois do pedido (P-1).** Um erro não HTTP (ex.: falha na leitura final de um pedido já `PAID`, erro Prisma ao gravar o pagamento) não vira `FAILED 500`: a chave continua `IN_PROGRESS` vinculada ao pedido e a posse é liberada na hora (`bloqueada_ate = agora`, condicionado ao token). O retry seguinte cai no replay do item 4 e recebe o pedido como está — `PENDING_PAYMENT` nunca é apresentado como pago pela API. Os erros HTTP desta fase só são lançados depois de o pedido ir para `CANCELLED`, por isso continuam gravados como `FAILED`.
6. **Fechamento** (`complete`/`fail`) é best-effort: se a escrita falhar, a resposta real do checkout não é mascarada; a linha fica `IN_PROGRESS` e é resolvida pelas regras do item 4.

Estados: `IN_PROGRESS` (com ou sem pedido) → `COMPLETED` (sempre com pedido) ou `FAILED` (sempre com pedido + status/corpo do erro). Os CHECKs da migration impedem combinações inválidas.

## 3. Compensações e pagamento (inalterados)

- Reserva falhou → pedido `CANCELLED` (como antes) e a chave guarda o erro.
- Gateway de pagamento indisponível → `finalizeFailedPayment` libera o estoque e cancela (como antes); a chave guarda o 503.
- Pagamento recusado → resposta 2xx com pedido `CANCELLED` (como antes); a chave fica `COMPLETED`.
- A idempotência é do **checkout no orders-service**. O adaptador de pagamento atual é mock; idempotência de cobrança no provedor externo depende do provedor escolhido (D-03) e não é prometida aqui.

## 4. Frontend (contrato recomendado)

- Uma chave (UUID v4) por **tentativa de compra**, guardada enquanto o payload não muda.
- Manter a mesma chave após falha de rede, 409 ou 5xx — inclusive o **503 do gateway quando o orders-service demora** (cold start), caso em que o pedido pode ter sido criado.
- Nova chave quando o carrinho, o endereço ou o cupom mudam, após sucesso, ou após 400/401/403/422.
- A tentativa sobrevive ao **refresh da mesma aba** (`sessionStorage`), guardando só `{v, key, fingerprint, expiresAt}`. O `fingerprint` é um hash de usuário + payload, sem endereço, itens ou cupom em claro. Outro usuário ou outro payload → nova chave. A tentativa expira 30 min depois do último envio. Fechar a aba descarta.
- Um 503 repetido **não** descarta a chave sozinho. O descarte automático em erro repetido depende de o frontend ler `Idempotent-Replayed`, que exige o gateway expor o header no CORS (pendência P-4).
- Implementação de referência: `marketing-place-potala-`, `src/lib/api/checkoutIdempotency.ts`.

## 5. Validação

| Item | Onde | Resultado |
|---|---|---|
| Orquestração (quem executa, repete, recebe 409/422; quantas reservas e cobranças) | `orders.checkout-idempotency.spec.ts` — **banco simulado** com UNIQUE e rollback | ver relatório F2.1 |
| Regras do serviço (posse, retomada, vínculo, fechamento, hash) | `checkout-idempotency.service.spec.ts` — **Prisma simulado** | idem |
| Contrato HTTP + guards reais de autenticação/papel | `orders.checkout.http.spec.ts` — supertest | idem |
| Migration aplicada após as 6 anteriores; atomicidade do SQL equivalente (INSERT ON CONFLICT concorrente, UPDATE condicional concorrente, vínculo × retomada, CHECKs, FK) | **PostgreSQL 16 descartável**, roteiro no relatório F2.1 do Projeto | 15/15 |
| Cliente Prisma real gerando esse SQL contra Postgres | — | **pendente de homologação** |

## 6. Operação

- **Não aplicar no Supabase compartilhado.** Ordem em homologação: `prisma migrate deploy` (esta migration depende de `orders.pedidos`).
- Antes de homologar, no Windows: `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url <banco descartável>` — diferença esperada: somente os CHECKs escritos à mão.
- Retenção: as linhas não são apagadas automaticamente (sem job de limpeza nesta entrega). Uma purga de chaves `COMPLETED`/`FAILED` antigas pode ser feita depois sem afetar pedidos (a FK impede apagar pedido que tem chave, não o contrário).
- Rollback do código: sem o header, o comportamento é o anterior; a tabela pode ficar no banco sem efeito.
