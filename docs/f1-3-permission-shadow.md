# F1.3 — Permissões granulares em modo sombra (orders-service)

Branch `feat/f1-3-permission-shadow` (base `3d2a789 (origin/fix/seller-checkout, que contém origin/main)`). 14/10/2026.

**Situação:** implementado e testado localmente (unitários e integração de
componentes HTTP em memória). **Não ativado em nenhum ambiente.** Nenhuma
regra de acesso mudou: `@Roles(...)`, `SessionAuthGuard`, `RolesGuard` e os
guards de vendedor continuam decidindo tudo. Não há modo de aplicação nesta
fase; a ativação real é a F1.6, depois de homologação.

## 1. O que existe

- `src/common/permissions/` (código próprio deste serviço, sem importar
  outro repositório nem consultar o banco `identity`):
  - `permission-catalog.mirror.ts` — espelho dos 50 códigos do catálogo F1.2
    (versão `2026-10-14.1`); o tipo `PermissionCode` impede, em compilação,
    declarar código inexistente;
  - `access-claims.ts` — leitura defensiva de `isSuperAdmin`/`grants` da
    introspecção;
  - `permission-evaluator.ts` — avaliador puro (sem I/O);
  - `require-permission.decorator.ts` — `@RequirePermission(código, escopo)` e
    `@PermissionPending(motivo)`;
  - `permission-shadow.interceptor.ts` — registra a decisão sombra.
- Flag `PERMISSION_SHADOW_MODE` (`false` por padrão; valor inválido derruba o
  boot, como as demais booleanas do serviço).
- `AuthenticatedUser` ganhou `isSuperAdmin?` e `grants?` opcionais (só tipo).

## 2. Contrato da decisão sombra

- **Interceptor, não guard.** Interceptores só rodam depois que todos os
  guards (globais e de rota) autorizaram. Por construção o modo sombra não
  libera nada que a regra atual negou, não muda 401/403/503 e só observa
  requisições já autorizadas.
- **Desligado (padrão):** `next.handle()` imediato; não lê metadados, não
  avalia, não registra.
- **Ligado:** avaliação síncrona e pura (sem chamada de rede, sem consulta ao
  banco, sem nova introspecção: usa o mesmo `request.authUser` que o
  `SessionAuthGuard` já obteve) e uma linha de log.
- **Erros:** qualquer exceção do avaliador vira `EVALUATION_ERROR`; falha do
  próprio log é engolida. A requisição segue idêntica.
- A resposta HTTP nunca é alterada (testado: mesmo status e mesmo corpo com a
  flag ligada e desligada).

**Resultados:** `WOULD_ALLOW`, `WOULD_DENY`, `NOT_EVALUATED`,
`EVALUATION_ERROR`, sempre com um `reason` de lista fechada:

| Situação | Resultado / motivo |
|---|---|
| Sem sessão | `NOT_EVALUATED` / `NO_SESSION` (na prática o guard já respondeu 401) |
| Usuário sem papel ADMIN (CUSTOMER, SELLER) | `WOULD_DENY` / `NOT_ADMIN` — concessões ignoradas |
| ADMIN não ativo | `WOULD_DENY` / `ACCOUNT_NOT_ACTIVE` |
| Introspecção antiga (sem `isSuperAdmin` nem `grants`) | `NOT_EVALUATED` / `LEGACY_INTROSPECTION` |
| Campos novos com forma inesperada | `NOT_EVALUATED` / `INVALID_CLAIMS` |
| Superadministrador apto (ADMIN + ACTIVE + `isSuperAdmin`) | `WOULD_ALLOW` / `SUPERADMIN` |
| Só F1.1 (tem `isSuperAdmin`, não tem `grants`) | `NOT_EVALUATED` / `GRANTS_UNAVAILABLE` |
| Rota sem código no catálogo | `NOT_EVALUATED` / `PERMISSION_PENDING_CATALOG` |
| Nenhuma concessão com a permissão | `WOULD_DENY` / `PERMISSION_MISSING` |
| Só concessões expiradas / marcadas revogadas | `WOULD_DENY` / `GRANT_EXPIRED` / `GRANT_REVOKED` |
| Concessão cobre o recurso | `WOULD_ALLOW` / `GRANT_COVERS` |
| Cobriria só com filtro por vendedor (inexistente hoje) | `WOULD_ALLOW` / `SCOPE_FILTER_REQUIRED` + `requiresFilter` |
| Dono do recurso não resolvido nesta fase | `NOT_EVALUATED` / `RESOURCE_SELLER_UNRESOLVED` ou `OWN_STORE_UNRESOLVED` |
| Escopo não cobre | `WOULD_DENY` / `SCOPE_NOT_COVERED` |

Ausência de permissão ou de dados **nunca** vira autorização.

## 3. Introspecção antiga e nova

O `IdentityServiceClient` já devolvia o JSON da introspecção sem filtrar
campos, então `isSuperAdmin` e `grants` (F1.1/F1.2) chegam em
`request.authUser` sem chamada extra. Com a produção ainda no contrato antigo,
toda decisão sai `NOT_EVALUATED / LEGACY_INTROSPECTION` — inclusive com a flag
ligada. Nada no acesso atual depende dos campos novos.

## 4. Escopos

Cada concessão é julgada **isoladamente**: a permissão e o escopo precisam
estar na mesma concessão (teste: permissão do vendedor A + escopo do vendedor
B em outra concessão ⇒ `WOULD_DENY`).

| Modo da rota | GLOBAL | SELLERS | OWN_STORE |
|---|---|---|---|
| `PLATFORM` (recurso da plataforma) | cobre | não cobre | não cobre |
| `COLLECTION` (listagem de todos os vendedores) | cobre | só com filtro (`requiresFilter`) | só com filtro, se a loja do usuário for conhecida; senão não avaliado |
| `SELLER` (rota identifica o vendedor) | cobre | cobre se o id estiver na lista | cobre se for a loja confiável do usuário; senão não avaliado |
| `SELLER_OWNED` (produto, pedido, devolução, reclamação, disputa) | cobre | não avaliado (dono não resolvido) | não avaliado |

- A loja do próprio usuário só vem de `request.sellerContext` (preenchido pelo
  `SellerContextGuard` a partir do vínculo de membro). Corpo, query e headers
  nunca são lidos. Em rotas administrativas esse contexto não existe, então
  `OWN_STORE` fica `NOT_EVALUATED`.
- **Nenhum filtro de banco foi aplicado.** O isolamento por vendedor NÃO está
  implementado: a existência das declarações não garante isolamento.

## 5. Logs e observabilidade

Uma linha JSON por decisão, logger `PermissionShadow`, evento
`permission_shadow`:

```json
{"event":"permission_shadow","service":"orders-service","catalogVersion":"2026-10-14.1",
 "method":"PATCH","route":"/api/v1/admin/...","handler":"Controller.metodo",
 "permission":"...","scopeMode":"SELLER","outcome":"WOULD_DENY",
 "reason":"SCOPE_NOT_COVERED","grantId":"...","roleKey":"...","scopeType":"SELLERS",
 "userRef":"<hash de 16 hex>","correlationId":"<x-correlation-id ou x-request-id válido>"}
```

- **Nunca registra:** cookie, token, chave interna, corpo da requisição,
  e-mail, id do usuário (só um pseudônimo por hash), URL real (só o padrão da
  rota, sem ids), documentos ou dados de pedido (testado).
- **Volume:** só rotas administrativas declaradas e só com a flag ligada (no
  máximo uma linha por requisição administrativa).
- **Métricas:** os campos `service`, `route`, `permission`, `outcome` e
  `reason` permitem agregar contagens no coletor de logs existente, sem
  infraestrutura nova. Nenhum endpoint de métricas foi criado.

## 6. Rotas administrativas deste serviço

| Método | Rota | Controller | Guard/role atual | Permissão pretendida | Escopo | Cobertura |
|---|---|---|---|---|---|---|
| GET | /admin/orders | AdminOrdersController.list | Session + Roles(ADMIN) | `orders:order:read` | COLLECTION | declarada |
| GET | /admin/returns | AdminReturnsController.list | idem | `aftersales:return:read` | COLLECTION | declarada |
| PATCH | /admin/returns/:id/approve | AdminReturnsController.approve | idem | `aftersales:return:approve` | SELLER_OWNED | declarada |
| PATCH | /admin/returns/:id/reject | AdminReturnsController.reject | idem | `aftersales:return:approve` (aprovar ou recusar) | SELLER_OWNED | declarada |
| GET | /admin/claims | AdminClaimsController.list | idem | `aftersales:claim:read` | COLLECTION | declarada |
| GET | /admin/claims/:id | AdminClaimsController.getOne | idem | `aftersales:claim:read` | SELLER_OWNED | declarada |
| POST | /admin/claims/:id/messages | AdminClaimsController.addMessage | idem | `aftersales:claim:update` | SELLER_OWNED | declarada |
| POST | /admin/claims/:id/evidence | AdminClaimsController.addEvidence | idem | `aftersales:claim:update` | SELLER_OWNED | declarada |
| PATCH | /admin/claims/:id/escalate | AdminClaimsController.escalate | idem | `aftersales:claim:update` | SELLER_OWNED | declarada |
| PATCH | /admin/claims/:id/resolve | AdminClaimsController.resolve | idem | `aftersales:claim:update` | SELLER_OWNED | declarada |
| PATCH | /admin/claims/:id/close | AdminClaimsController.close | idem | `aftersales:claim:update` | SELLER_OWNED | declarada |
| POST | /admin/claims/:id/dispute | AdminClaimsController.openDisputeFromClaim | idem | `aftersales:dispute:update` | SELLER_OWNED | declarada |
| POST | /admin/returns/:id/dispute | AdminClaimsController.openDisputeFromReturn | idem | `aftersales:dispute:update` | SELLER_OWNED | declarada |
| GET | /admin/disputes | AdminDisputesController.list | idem | `aftersales:dispute:read` | COLLECTION | declarada |
| GET | /admin/disputes/:id | AdminDisputesController.getOne | idem | `aftersales:dispute:read` | SELLER_OWNED | declarada |
| POST | /admin/disputes/:id/decisions | AdminDisputesController.recordDecision | idem | `aftersales:dispute:update` | SELLER_OWNED | declarada |
| GET | /admin/coupons | AdminCouponsController.list | idem | `marketing:coupon:read` | PLATFORM | declarada |
| POST | /admin/coupons | AdminCouponsController.create | idem | `marketing:coupon:create` | PLATFORM | declarada |
| PATCH | /admin/coupons/:id | AdminCouponsController.update | idem | `marketing:coupon:update` | PLATFORM | declarada |
| PATCH | /admin/coupons/:id/activate | AdminCouponsController.activate | idem | `marketing:coupon:update` (não há verbo "activate") | PLATFORM | declarada |
| PATCH | /admin/coupons/:id/deactivate | AdminCouponsController.deactivate | idem | `marketing:coupon:deactivate` | PLATFORM | declarada |
| DELETE | /admin/coupons/:id | AdminCouponsController.remove | idem | — | — | **lacuna do catálogo** |

- `DELETE /admin/coupons/:id` é exclusão física; o catálogo F1.2 não tem verbo
  de exclusão (e o risco R-8 propõe exclusão lógica). Fica `@PermissionPending`.
- Decisões de disputa a favor do cliente (`CUSTOMER_FAVORED`/`PARTIAL`) e
  resolução de reclamação podem implicar reembolso: na ativação, avaliar exigir
  também `aftersales:refund:approve` conforme o conteúdo da decisão
  (requisito condicional ao corpo, fora do alcance do decorator atual).
- **"Vendedor também compra" preservado:** `OrdersController` e
  `CustomerClaimsController` seguem `@Roles(CUSTOMER, SELLER)`, sem permissão
  granular (testes de cobertura e HTTP).

O teste `permission-coverage.spec.ts` descobre todos os controllers e falha
se uma rota com `@Roles(ADMIN)` não tiver `@RequirePermission` nem
`@PermissionPending`, se a matriz mudar sem atualizar o teste, se uma rota
administrativa deixar de ser só ADMIN, ou se uma rota de cliente, vendedor,
pública ou interna ganhar permissão granular.

## 7. Onde a ativação (F1.6) vai precisar de filtros ou consultas

- `GET /admin/orders`: um pedido pode ter itens de vários vendedores;
  decidir se um escopo `SELLERS` vê o pedido inteiro ou só os itens dos seus
  vendedores (decisão de produto) e filtrar por `OrderItem.sellerId`.
- Devoluções, reclamações e disputas: resolver o vendedor pelo item do pedido
  antes de decidir as rotas `SELLER_OWNED`; listar com filtro equivalente.
- Cupons são da plataforma: só `GLOBAL`.
- Checkout, estoque, pagamento, rotas do comprador e da loja não ganham
  permissão granular.

## 8. Como ligar em homologação (quando autorizado)

1. Identity com F1.1 + F1.2 aplicadas e catálogo sincronizado.
2. `PERMISSION_SHADOW_MODE=true` neste serviço; reiniciar.
3. Acompanhar `permission_shadow` por `outcome`/`reason`/`route`.
4. Desligar: voltar a `false` e reiniciar (sem efeito em dados).
