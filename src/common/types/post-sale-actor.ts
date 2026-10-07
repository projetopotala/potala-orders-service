import { Role } from './identity-enums';

/**
 * Quem está chamando um método de pós-venda (Claim/Dispute) -- resolvido a
 * partir do contexto de autenticação já produzido pelos guards existentes
 * (SessionAuthGuard preenche request.authUser; SellerContextGuard preenche
 * request.sellerContext), NUNCA do corpo da requisição. Discriminado por
 * `role` usando o mesmo enum `Role` de identity-enums.ts (CUSTOMER/SELLER/
 * ADMIN) que o resto do projeto já usa em @Roles(...) -- não um enum novo.
 *
 * customerId/sellerId aqui são loose UUIDs (identity-service/
 * sellers-service), mesmo padrão de snapshot já usado em todo o schema
 * orders -- nunca uma FK cross-schema, e este tipo nunca consulta
 * identity-service/sellers-service diretamente: quem resolve esses campos
 * é o controller futuro, a partir de request.authUser.id (customerId) ou
 * request.sellerContext.sellerId (sellerId), exatamente como
 * SellerContextGuard já faz hoje para outros controllers.
 */
export type PostSaleActor =
  | { role: Role.CUSTOMER; userId: string; customerId: string }
  | { role: Role.SELLER; userId: string; sellerId: string }
  | { role: Role.ADMIN; userId: string };
