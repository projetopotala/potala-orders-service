/**
 * F1.3 -- espelho LOCAL dos códigos de permissão do catálogo F1.2 do
 * identity-service (src/modules/access/access-catalog.ts, versão abaixo).
 *
 * Este serviço não importa código de outro repositório nem consulta o banco
 * `identity`: os códigos são copiados à mão, como já é feito com os enums
 * `Role`/`UserStatus` (common/types/identity-enums.ts). Uma permissão só
 * pode ser declarada em rota se estiver aqui (o tipo `PermissionCode`
 * garante em compilação). Ao mudar o catálogo no identity-service, atualizar
 * esta lista e a versão juntos.
 *
 * Gestão de acessos (papéis, concessões, superadmin) não está no catálogo
 * por decisão da F1.2: é exclusiva de `isSuperAdmin`.
 */
export const PERMISSION_CATALOG_MIRROR_VERSION = '2026-10-14.1';

export const PERMISSION_CODES = [
  'dashboard:overview:read',
  'sellers:seller:read',
  'sellers:seller:approve',
  'sellers:seller:update',
  'sellers:seller:suspend',
  'sellers:document:read',
  'catalog:product:read',
  'catalog:product:approve',
  'catalog:product:update',
  'catalog:product:deactivate',
  'catalog:category:manage',
  'orders:order:read',
  'orders:order:update',
  'orders:order:export',
  'orders:shipment:update',
  'aftersales:claim:read',
  'aftersales:claim:update',
  'aftersales:return:read',
  'aftersales:return:approve',
  'aftersales:dispute:read',
  'aftersales:dispute:update',
  'aftersales:refund:approve',
  'customers:customer:read',
  'customers:customer:suspend',
  'customers:customer:export',
  'finance:transaction:read',
  'finance:settlement:reconcile',
  'finance:commission:read',
  'finance:commission:manage',
  'finance:payout:read',
  'finance:payout:create',
  'finance:payout:approve',
  'finance:payout:execute',
  'finance:refund:execute',
  'finance:report:export',
  'marketing:coupon:read',
  'marketing:coupon:create',
  'marketing:coupon:update',
  'marketing:coupon:deactivate',
  'marketing:campaign:read',
  'marketing:campaign:manage',
  'marketing:analytics:read',
  'reports:operational:read',
  'reports:operational:export',
  'reports:financial:read',
  'reports:financial:export',
  'identity:admin:read',
  'identity:audit:read',
  'system:health:read',
  'system:integration:read',
] as const;

export type PermissionCode = (typeof PERMISSION_CODES)[number];

export const PERMISSION_CODE_PATTERN =
  /^[a-z]+(-[a-z]+)*:[a-z]+(-[a-z]+)*:[a-z]+(-[a-z]+)*$/;

const CODE_SET: ReadonlySet<string> = new Set(PERMISSION_CODES);

export function isMirroredPermission(code: string): code is PermissionCode {
  return CODE_SET.has(code);
}
