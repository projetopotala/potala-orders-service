import { Role, UserStatus } from '../types/identity-enums';
import {
  AccessScopeType,
  ParsedGrant,
  parseAccessClaims,
} from './access-claims';
import {
  PermissionRequirement,
  PermissionScope,
} from './require-permission.decorator';

/**
 * F1.3 -- avaliador PURO da política granular (sem I/O, sem efeitos).
 * Só produz uma decisão sombra; quem decide o acesso continua sendo
 * SessionAuthGuard + RolesGuard (+ guards de vendedor).
 *
 * Associação permissão-escopo: cada concessão é julgada isoladamente (a
 * permissão E o escopo precisam estar na MESMA concessão). Nunca se junta a
 * permissão de uma concessão com o escopo de outra.
 */
export type ShadowOutcome =
  'WOULD_ALLOW' | 'WOULD_DENY' | 'NOT_EVALUATED' | 'EVALUATION_ERROR';

export type ShadowReason =
  | 'SUPERADMIN'
  | 'GRANT_COVERS'
  | 'SCOPE_FILTER_REQUIRED'
  | 'NOT_ADMIN'
  | 'ACCOUNT_NOT_ACTIVE'
  | 'PERMISSION_MISSING'
  | 'GRANT_EXPIRED'
  | 'GRANT_REVOKED'
  | 'SCOPE_NOT_COVERED'
  | 'NO_SESSION'
  | 'LEGACY_INTROSPECTION'
  | 'GRANTS_UNAVAILABLE'
  | 'INVALID_CLAIMS'
  | 'PERMISSION_PENDING_CATALOG'
  | 'RESOURCE_SELLER_UNRESOLVED'
  | 'OWN_STORE_UNRESOLVED'
  | 'INVALID_RESOURCE_ID'
  | 'EVALUATOR_EXCEPTION';

export interface ShadowDecision {
  outcome: ShadowOutcome;
  reason: ShadowReason;
  /** Concessão que determinou a decisão (quando houver). */
  grantId?: string;
  roleKey?: string | null;
  scopeType?: AccessScopeType;
  /** WOULD_ALLOW que só valeria com filtro por vendedor ainda inexistente. */
  requiresFilter?: boolean;
}

export interface EvaluationInput {
  /** `request.authUser` exatamente como o SessionAuthGuard o deixou. */
  user: unknown;
  requirement: PermissionRequirement;
  /** Parâmetros de rota já resolvidos pelo roteador (não o corpo). */
  params: Record<string, unknown> | undefined;
  /**
   * Loja do próprio usuário, SÓ de fonte confiável do servidor
   * (`request.sellerContext`, preenchido pelo SellerContextGuard a partir do
   * vínculo de membro). Nunca de corpo, query ou header.
   */
  trustedOwnSellerId: string | undefined;
  now: Date;
}

type Coverage =
  | { kind: 'covered' }
  | { kind: 'filter' }
  | { kind: 'unresolved'; reason: ShadowReason }
  | { kind: 'not_covered' };

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function coverage(
  grant: ParsedGrant,
  scope: PermissionScope,
  params: Record<string, unknown> | undefined,
  ownSellerId: string | undefined,
): Coverage {
  if (grant.scopeType === 'GLOBAL') {
    return { kind: 'covered' };
  }
  switch (scope.mode) {
    case 'PLATFORM':
      return { kind: 'not_covered' };
    case 'COLLECTION':
      if (grant.scopeType === 'SELLERS') {
        return { kind: 'filter' };
      }
      return ownSellerId
        ? { kind: 'filter' }
        : { kind: 'unresolved', reason: 'OWN_STORE_UNRESOLVED' };
    case 'SELLER': {
      const raw = params?.[scope.sellerIdParam];
      if (typeof raw !== 'string' || !UUID.test(raw)) {
        return { kind: 'unresolved', reason: 'INVALID_RESOURCE_ID' };
      }
      const target = raw.toLowerCase();
      if (grant.scopeType === 'SELLERS') {
        return grant.sellerIds.includes(target)
          ? { kind: 'covered' }
          : { kind: 'not_covered' };
      }
      if (!ownSellerId) {
        return { kind: 'unresolved', reason: 'OWN_STORE_UNRESOLVED' };
      }
      return ownSellerId.toLowerCase() === target
        ? { kind: 'covered' }
        : { kind: 'not_covered' };
    }
    case 'SELLER_OWNED':
      return {
        kind: 'unresolved',
        reason:
          grant.scopeType === 'OWN_STORE' && !ownSellerId
            ? 'OWN_STORE_UNRESOLVED'
            : 'RESOURCE_SELLER_UNRESOLVED',
      };
  }
}

function grantInfo(grant: ParsedGrant) {
  return {
    grantId: grant.grantId,
    roleKey: grant.roleKey,
    scopeType: grant.scopeType,
  };
}

export function evaluatePermission(input: EvaluationInput): ShadowDecision {
  const user = input.user as
    { roles?: unknown; status?: unknown } | undefined | null;
  if (!user) {
    return { outcome: 'NOT_EVALUATED', reason: 'NO_SESSION' };
  }

  // Só ADMIN ativo pode ter permissão administrativa (mesma regra da
  // resolução no identity-service): concessões em conta CUSTOMER/SELLER
  // nunca contam.
  const roles = Array.isArray(user.roles) ? (user.roles as unknown[]) : [];
  if (!roles.includes(Role.ADMIN)) {
    return { outcome: 'WOULD_DENY', reason: 'NOT_ADMIN' };
  }
  if (user.status !== UserStatus.ACTIVE) {
    return { outcome: 'WOULD_DENY', reason: 'ACCOUNT_NOT_ACTIVE' };
  }

  const claims = parseAccessClaims(input.user);
  if (claims.kind === 'legacy') {
    return { outcome: 'NOT_EVALUATED', reason: 'LEGACY_INTROSPECTION' };
  }
  if (claims.kind === 'invalid') {
    return { outcome: 'NOT_EVALUATED', reason: 'INVALID_CLAIMS' };
  }
  if (claims.isSuperAdmin === true) {
    return { outcome: 'WOULD_ALLOW', reason: 'SUPERADMIN' };
  }
  if (input.requirement.kind === 'pending') {
    return { outcome: 'NOT_EVALUATED', reason: 'PERMISSION_PENDING_CATALOG' };
  }
  if (claims.grants === undefined) {
    return { outcome: 'NOT_EVALUATED', reason: 'GRANTS_UNAVAILABLE' };
  }

  const { permission, scope } = input.requirement;
  const withPermission = claims.grants.filter((grant) =>
    grant.permissions.has(permission),
  );
  if (withPermission.length === 0) {
    return { outcome: 'WOULD_DENY', reason: 'PERMISSION_MISSING' };
  }
  const notRevoked = withPermission.filter((grant) => !grant.revoked);
  if (notRevoked.length === 0) {
    return { outcome: 'WOULD_DENY', reason: 'GRANT_REVOKED' };
  }
  const valid = notRevoked.filter(
    (grant) =>
      grant.expiresAt === null ||
      grant.expiresAt.getTime() > input.now.getTime(),
  );
  if (valid.length === 0) {
    return { outcome: 'WOULD_DENY', reason: 'GRANT_EXPIRED' };
  }

  const ownSellerId =
    typeof input.trustedOwnSellerId === 'string' &&
    UUID.test(input.trustedOwnSellerId)
      ? input.trustedOwnSellerId
      : undefined;

  let filterGrant: ParsedGrant | undefined;
  let unresolved: { grant: ParsedGrant; reason: ShadowReason } | undefined;
  for (const grant of valid) {
    const result = coverage(grant, scope, input.params, ownSellerId);
    if (result.kind === 'covered') {
      return {
        outcome: 'WOULD_ALLOW',
        reason: 'GRANT_COVERS',
        ...grantInfo(grant),
      };
    }
    if (result.kind === 'filter') {
      filterGrant ??= grant;
    } else if (result.kind === 'unresolved') {
      unresolved ??= { grant, reason: result.reason };
    }
  }
  if (filterGrant) {
    return {
      outcome: 'WOULD_ALLOW',
      reason: 'SCOPE_FILTER_REQUIRED',
      requiresFilter: true,
      ...grantInfo(filterGrant),
    };
  }
  if (unresolved) {
    return {
      outcome: 'NOT_EVALUATED',
      reason: unresolved.reason,
      ...grantInfo(unresolved.grant),
    };
  }
  return { outcome: 'WOULD_DENY', reason: 'SCOPE_NOT_COVERED' };
}
