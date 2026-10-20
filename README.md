# Marketplace Potala — orders-service

Quinto serviço da migração para microsserviços. Dono do schema Postgres
`orders` — pedidos, itens de pedido por vendedor e transações de pagamento.
Diferente dos quatro serviços anteriores, **não é um porte 1:1** de um
módulo existente: o `OrdersService` do monólito de origem
(`marketing-place-potala-backend-main`, `modules/orders`) era um esqueleto de
fundação — só `listByCustomer`, sem controller HTTP, e o próprio código do
monólito documentava checkout como "not implemented in this foundation
stage". Não existe carrinho, cobrança nem webhook de pagamento em lugar
nenhum do sistema de origem. Ver "Decisões desta v1" abaixo para o que este
serviço decide e por quê.

## Decisões desta v1 — decisão explícita do Arthur

Ao chegar nesta etapa, dois gaps reais do monólito precisavam de uma decisão
que nenhum código existente já resolvia: de onde vem o carrinho, e como o
pagamento é cobrado. As opções foram apresentadas ao Arthur; a resposta foi
delegar a decisão ("faça o que for melhor e que vai funcionar"), então as
duas opções recomendadas abaixo foram as escolhidas.

- **Carrinho stateless (client-side)**: não existe modelo `Cart` persistido.
  `POST /orders/checkout` recebe a lista de itens (`productId`, `variantId`,
  `quantity`) direto no corpo da requisição — o "carrinho" vive inteiramente
  no cliente (frontend) até o momento do checkout. Nada vindo do cliente é
  gravado como está: preço, vendedor, status do produto e estoque disponível
  são sempre resolvidos e validados contra catalog-service antes de qualquer
  linha ser persistida (ver `docs/internal-api-contract.md`). Alternativa
  descartada: um modelo `Cart` persistido por cliente, com sincronização
  entre dispositivos — maior superfície e nenhum requisito hoje o justifica.
- **Gateway de pagamento simulado (mock, sempre aprova)**: `PaymentGatewayClient`
  é uma interface própria (`src/modules/payments/payment-gateway.interface.ts`),
  hoje implementada só por `MockPaymentGatewayAdapter` — nunca fala com uma
  rede de pagamento real, sempre retorna `APPROVED` com uma `providerRef`
  gerada localmente (`mock_<uuid>`), e loga um aviso explícito de que não é
  uma integração real toda vez que é chamado. O ponto de troca para um
  gateway real é único: implementar `PaymentGatewayClient` numa nova classe e
  trocar o `useClass` em `payments.module.ts` — nada em `OrdersService` ou no
  DTO de checkout muda. Coluna `provider`/`providerRef` em
  `PaymentTransaction` já é agnóstica de provedor por isso.

## Responsabilidade

- `POST /orders/checkout` — cria um pedido a partir do carrinho enviado,
  agrupa por vendedor (`SellerOrder` por `sellerId` distinto), reserva
  estoque em catalog-service, cobra via `PaymentGatewayClient` e finaliza
  como `PAID` (com `commitInventory`) ou `CANCELLED` (com
  `releaseInventory`) — tudo síncrono, numa única requisição.
- `GET /orders` (paginado por cursor), `GET /orders/:id` — histórico e
  detalhe dos próprios pedidos do cliente autenticado (`@Roles(CUSTOMER)`,
  isolamento por tenant em SQL, nunca pós-filtragem).
- `GET /health`, `GET /health/ready`.

## O que este v1 **não** faz (decisão deliberada, documentada)

- **Carrinho persistido**: ver "Decisões desta v1" acima.
- **Gateway de pagamento real**: ver "Decisões desta v1" acima. Nenhuma
  credencial de nenhum provedor real existe neste serviço.
- **Frete e comissão**: `shippingCents`/`commissionCents` são sempre `0` —
  não há regra de cálculo de frete nem de comissão por vendedor definida em
  lugar nenhum do sistema de origem. `Order`/`SellerOrder` já têm as colunas
  prontas (herdadas do schema do monólito) para quando essa regra existir.
- **Webhook de confirmação assíncrona de pagamento**: o mock é síncrono
  (aprova/rejeita na mesma requisição de checkout), então não há necessidade
  de webhook nesta v1 — mas um gateway real provavelmente vai precisar de
  um, e nada aqui foi desenhado para isso ainda.
- **Idempotência de checkout**: um duplo-clique ou um retry de rede em
  `POST /orders/checkout` cria dois pedidos distintos (dois `orderNumber`
  diferentes, dois `reserveInventory` diferentes). Não há chave de
  idempotência por requisição nesta v1.
- **Reconciliação em segundo plano**: se `commitInventory`/`releaseInventory`
  falhar depois que a decisão de pagamento já foi persistida localmente, o
  erro é só logado — não há job de retry nem fila. O pedido fica com o
  status correto no banco deste serviço, mas o estoque em catalog-service
  pode ficar "reservado, nunca comprometido nem liberado" até alguém
  reconciliar manualmente. Ver `docs/internal-api-contract.md`.
- **Visão do vendedor sobre seus próprios `SellerOrder`s**: esta v1 só tem o
  endpoint do cliente (`Role.CUSTOMER`). Um `GET /seller/orders` fica para
  quando o Arthur priorizar.
- **Validação de sessão centralizada**: como os demais serviços, este ainda
  lê o cookie e chama identity-service a cada request — sem api-gateway v1
  fazendo isso uma vez só.

## Por que a autenticação aqui é resolvida por rede

Este serviço não tem tabela de sessão — `SessionAuthGuard` chama
identity-service (`POST /internal/sessions/introspect`), mesmo padrão dos
quatro serviços anteriores. E, diferente deles, **não tem nenhum dado local
de produto/variante/preço/estoque** — toda validação de carrinho é uma
chamada de rede a catalog-service. `IDENTITY_SERVICE_URL`/
`IDENTITY_SERVICE_API_KEY` e `CATALOG_SERVICE_URL`/`CATALOG_SERVICE_API_KEY`
são ambas obrigatórias: nenhuma rota autenticada responde sem as duas
dependências no ar, e checkout especificamente não pode nem validar uma
única linha de carrinho sem catalog-service. Ver
[`docs/internal-api-contract.md`](docs/internal-api-contract.md) para o
contrato completo.

Este serviço **não expõe nenhuma rota `/internal/*` própria** nesta v1 — é
sempre cliente, nunca callee, de identity-service e catalog-service. Por
isso não há `InternalApiKeyGuard`, `INTERNAL_API_KEY` nem segundo grupo de
throttle aqui — só o grupo `default`, diferente de catalog-service e
sellers-service (que ganharam essas peças justamente para atender este
serviço).

## Por que uma transação Postgres nunca fica aberta esperando uma chamada de rede

Regra do projeto, escrita pela primeira vez no comentário do model
`Inventory` em catalog-service e repetida aqui, agora com um caso real que a
justifica: `checkout` cria `Order`+`SellerOrder`+`OrderItem` numa transação
**curta**, a transação fecha, e só **depois** deste commit local é que
`reserveInventory` (rede) e o gateway de pagamento (rede) são chamados —
nunca dentro de uma transação aberta. Isso significa que o pedido pode
existir localmente como `PENDING_PAYMENT` por um instante antes de qualquer
chamada de rede acontecer; é uma escolha deliberada (nunca segurar um lock
de banco esperando outro serviço responder), não um descuido.

## Stack

- Node.js 20+ / NestJS / TypeScript strict
- Prisma 6 (`previewFeatures = ["multiSchema"]`), schema Postgres `orders`
- `class-validator` / `class-transformer`, `@nestjs/throttler`, Swagger

## Requisitos

- Node.js >= 20
- npm
- Um projeto Supabase (PostgreSQL) — o mesmo projeto usado pelos outros
  serviços, desde que cada um migre **apenas o seu próprio schema**
- identity-service **e** catalog-service rodando e alcançáveis (toda rota
  autenticada precisa dos dois; checkout especificamente não funciona sem
  catalog-service)

## Instalação

```bash
npm install
cp .env.example .env
```

Preencha `DATABASE_URL` / `DIRECT_URL` com as credenciais do Supabase e as
duas chaves internas de saída (devem bater com `INTERNAL_API_KEY` de
identity-service e de catalog-service, respectivamente — ver
`.env.example`), depois:

```bash
npx prisma migrate deploy
npx prisma generate
```

## Execução local

```bash
npm run start:dev
```

- Liveness: `GET http://localhost:3004/api/v1/health` — sempre `200`.
- Readiness: `GET http://localhost:3004/api/v1/health/ready` — `200` só se
  o Postgres deste serviço responder; não verifica identity-service nem
  catalog-service (mesmo padrão dos outros serviços — cada um só reporta a
  própria saúde).

## Testes, lint e build

```bash
npm test
npm run lint
npm run build
```

Como nos quatro serviços anteriores, **não executado neste ambiente**
(sandbox sem acesso a `registry.npmjs.org`) — revisado manualmente
(consistência de imports, balanceamento de chaves/parênteses, schema Prisma
comparado à migration SQL escrita à mão). `npm install && npm test && npm
run build` local é o próximo passo obrigatório antes de qualquer deploy.

A suíte de testes cobre `OrdersService`: checkout multi-vendedor (totais
corretos, agrupamento por `sellerId`), validação de carrinho contra
catalog-service (variante inexistente, `productId` incompatível, produto
inativo, estoque insuficiente na checagem antecipada), falha de reserva de
estoque (pedido cancelado, erro original propagado), pagamento recusado
(sem lançar exceção — libera estoque e cancela), pagamento com gateway
inacessível (503, libera estoque), retry de número de pedido em conflito
(incluindo o caso de esgotar o orçamento de retries), e o guard de overflow
int4. Também cobre `CreateCheckoutDto`, paginação, `env.validation` e os
guards (`SessionAuthGuard`/`RolesGuard`/`OriginGuard` — sem a isenção de
`/internal/*`, já que este serviço não expõe nenhuma).

## Variáveis de ambiente

Ver [`.env.example`](.env.example) — comentado variável a variável.

## Próximos passos sugeridos (fora do escopo deste serviço)

1. **Gateway de pagamento real**: trocar `MockPaymentGatewayAdapter` por um
   adapter real implementando `PaymentGatewayClient` — o único ponto de
   troca é `payments.module.ts`. Decisão consciente de ficar fora desta v1,
   não esquecida.
2. **`GET /seller/orders`**: visão do vendedor sobre seus próprios
   `SellerOrder`s — não existe nesta v1.
3. **Idempotência de checkout** (chave de idempotência por requisição) e
   **reconciliação em segundo plano** para o gap de
   `commitInventory`/`releaseInventory` — ambos documentados como gaps
   conhecidos, não implementados especulativamente agora.
4. Cálculo real de frete e comissão por vendedor, quando essa regra de
   negócio existir em algum lugar do sistema.
5. Centralizar a validação de sessão em `potala-api-gateway`, eliminando a
   chamada de rede a identity-service por requisição autenticada.
6. Wiring deste serviço em `potala-api-gateway` (`/api/v1/orders/*`) — ver
   commit correspondente em `potala-api-gateway`.

## Checkout para vendedores — atualização de outubro/2026

O Marketplace Potala permite que vendedores realizem compras
utilizando a mesma conta cadastrada como vendedor.

### Regras de autorização

- CUSTOMER: pode realizar compras normalmente.
- SELLER: pode realizar compras com a mesma conta.
- ADMIN: não possui acesso às rotas de comprador.

O checkout identifica o comprador pelo `authUser.id`
da sessão autenticada.

O vendedor mantém acesso ao seu painel administrativo
e aos pedidos relacionados às suas vendas.

### Validação

A correção foi implementada na branch `fix/seller-checkout`.

- Build do Orders Service: aprovado.
- Testes automatizados do Orders Service: 376 aprovados.
- Checkout completo: pendente de homologação em Preview.

Observação: o gateway de pagamento atual é simulado.
