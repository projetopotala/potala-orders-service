import { PERMISSION_CODE_PATTERN } from './permission-catalog.mirror';

/**
 * F1.3 -- leitura DEFENSIVA dos campos de acesso que a introspecção do
 * identity-service passou a devolver na F1.2 (`isSuperAdmin`, `grants`).
 *
 * Os dados vêm do mesmo objeto `request.authUser` que o SessionAuthGuard já
 * obteve: nenhuma chamada extra de introspecção é feita. Como produção ainda
 * pode responder o contrato antigo, os campos são opcionais e qualquer forma
 * inesperada vira `invalid` -- nunca uma autorização.
 */
export type AccessScopeType = 'GLOBAL' | 'SELLERS' | 'OWN_STORE';

export interface ParsedGrant {
  grantId: string;
  roleKey: string | null;
  permissions: ReadonlySet<string>;
  scopeType: AccessScopeType;
  /** Só SELLERS; UUIDs em minúsculas. */
  sellerIds: readonly string[];
  expiresAt: Date | null;
  /** O contrato F1.2 não envia concessões revogadas; defensivo caso envie. */
  revoked: boolean;
}

export type AccessClaims =
  | { kind: 'legacy' }
  | { kind: 'invalid'; detail: string }
  | {
      kind: 'available';
      isSuperAdmin: boolean | undefined;
      /** undefined = identity com F1.1 mas sem F1.2 (sem concessões no contrato). */
      grants: ParsedGrant[] | undefined;
    };

const SCOPE_TYPES: ReadonlySet<string> = new Set([
  'GLOBAL',
  'SELLERS',
  'OWN_STORE',
]);
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_GRANTS = 200;
const MAX_PERMISSIONS_PER_GRANT = 200;
const MAX_SELLERS_PER_GRANT = 100;

class InvalidClaims extends Error {}

function fail(detail: string): never {
  throw new InvalidClaims(detail);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseGrant(raw: unknown): ParsedGrant {
  if (!isRecord(raw)) {
    fail('grant_not_object');
  }
  const { grantId, roleKey, permissions, scope, expiresAt } = raw;
  if (typeof grantId !== 'string' || !UUID.test(grantId)) {
    fail('grant_id');
  }
  if (
    roleKey !== null &&
    roleKey !== undefined &&
    typeof roleKey !== 'string'
  ) {
    fail('grant_role_key');
  }
  if (
    !Array.isArray(permissions) ||
    permissions.length > MAX_PERMISSIONS_PER_GRANT ||
    !permissions.every(
      (code) => typeof code === 'string' && PERMISSION_CODE_PATTERN.test(code),
    )
  ) {
    fail('grant_permissions');
  }
  if (
    !isRecord(scope) ||
    typeof scope.type !== 'string' ||
    !SCOPE_TYPES.has(scope.type)
  ) {
    fail('grant_scope_type');
  }
  const scopeType = scope.type as AccessScopeType;
  const rawSellers = scope.sellerIds ?? [];
  if (
    !Array.isArray(rawSellers) ||
    rawSellers.length > MAX_SELLERS_PER_GRANT ||
    !rawSellers.every((id) => typeof id === 'string' && UUID.test(id))
  ) {
    fail('grant_seller_ids');
  }
  const sellerIds = (rawSellers as string[]).map((id) => id.toLowerCase());
  // Mesma regra do CHECK da F1.2: só SELLERS tem lista, e nunca vazia.
  if (scopeType === 'SELLERS' ? sellerIds.length === 0 : sellerIds.length > 0) {
    fail('grant_scope_consistency');
  }
  let expiry: Date | null = null;
  if (expiresAt !== null && expiresAt !== undefined) {
    if (typeof expiresAt !== 'string') {
      fail('grant_expires_at');
    }
    expiry = new Date(expiresAt);
    if (Number.isNaN(expiry.getTime())) {
      fail('grant_expires_at');
    }
  }
  const revokedAt = raw.revokedAt;
  return {
    grantId: grantId.toLowerCase(),
    roleKey: typeof roleKey === 'string' ? roleKey : null,
    permissions: new Set(permissions as string[]),
    scopeType,
    sellerIds,
    expiresAt: expiry,
    revoked: revokedAt !== null && revokedAt !== undefined,
  };
}

export function parseAccessClaims(user: unknown): AccessClaims {
  if (!isRecord(user)) {
    return { kind: 'invalid', detail: 'user_not_object' };
  }
  const hasSuperAdmin = Object.prototype.hasOwnProperty.call(
    user,
    'isSuperAdmin',
  );
  const hasGrants = Object.prototype.hasOwnProperty.call(user, 'grants');
  if (!hasSuperAdmin && !hasGrants) {
    return { kind: 'legacy' };
  }
  try {
    if (hasSuperAdmin && typeof user.isSuperAdmin !== 'boolean') {
      fail('is_super_admin');
    }
    let grants: ParsedGrant[] | undefined;
    if (hasGrants) {
      if (!Array.isArray(user.grants) || user.grants.length > MAX_GRANTS) {
        fail('grants_not_array');
      }
      grants = (user.grants as unknown[]).map(parseGrant);
    }
    return {
      kind: 'available',
      isSuperAdmin: hasSuperAdmin ? (user.isSuperAdmin as boolean) : undefined,
      grants,
    };
  } catch (error) {
    if (error instanceof InvalidClaims) {
      return { kind: 'invalid', detail: error.message };
    }
    throw error;
  }
}
