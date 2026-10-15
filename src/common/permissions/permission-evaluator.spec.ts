import { Role, UserStatus } from '../types/identity-enums';
import { parseAccessClaims } from './access-claims';
import { EvaluationInput, evaluatePermission } from './permission-evaluator';
import {
  PERMISSION_CATALOG_MIRROR_VERSION,
  PERMISSION_CODES,
  PERMISSION_CODE_PATTERN,
} from './permission-catalog.mirror';
import { PermissionRequirement } from './require-permission.decorator';

const NOW = new Date('2026-10-14T12:00:00.000Z');
const SELLER_A = '0a000000-0000-4000-8000-00000000000a';
const SELLER_B = '0b000000-0000-4000-8000-00000000000b';
const G1 = '10000000-0000-4000-8000-000000000001';
const G2 = '20000000-0000-4000-8000-000000000002';

function grant(overrides: Record<string, unknown> = {}) {
  return {
    grantId: G1,
    roleId: '30000000-0000-4000-8000-000000000003',
    roleKey: 'OPERATIONS',
    permissions: ['orders:order:read'],
    scope: { type: 'GLOBAL', sellerIds: [] },
    expiresAt: null,
    ...overrides,
  };
}

function admin(overrides: Record<string, unknown> = {}) {
  return {
    id: 'u-1',
    email: 'admin@exemplo.test',
    status: UserStatus.ACTIVE,
    roles: [Role.ADMIN],
    isSuperAdmin: false,
    grants: [grant()],
    ...overrides,
  };
}

const required = (
  permission: string,
  scope: Extract<PermissionRequirement, { kind: 'required' }>['scope'] = {
    mode: 'COLLECTION',
  },
) => ({ kind: 'required', permission, scope }) as PermissionRequirement;

function evaluate(overrides: Partial<EvaluationInput> = {}) {
  return evaluatePermission({
    user: admin(),
    requirement: required('orders:order:read'),
    params: {},
    trustedOwnSellerId: undefined,
    now: NOW,
    ...overrides,
  });
}

describe('F1.3 -- avaliador sombra de permissões granulares', () => {
  describe('espelho do catálogo F1.2', () => {
    it('versão e formato idênticos ao identity-service (2026-10-14.1, 50 códigos)', () => {
      expect(PERMISSION_CATALOG_MIRROR_VERSION).toBe('2026-10-14.1');
      expect(PERMISSION_CODES).toHaveLength(50);
      expect(new Set(PERMISSION_CODES).size).toBe(50);
      for (const code of PERMISSION_CODES) {
        expect(code).toMatch(PERMISSION_CODE_PATTERN);
      }
    });
  });

  describe('introspecção antiga x nova', () => {
    it('contrato antigo (sem isSuperAdmin nem grants) -> NOT_EVALUATED, nunca autorização', () => {
      const legacy = {
        id: 'u',
        email: 'a@x',
        status: 'ACTIVE',
        roles: ['ADMIN'],
      };
      expect(parseAccessClaims(legacy)).toEqual({ kind: 'legacy' });
      expect(evaluate({ user: legacy })).toEqual({
        outcome: 'NOT_EVALUATED',
        reason: 'LEGACY_INTROSPECTION',
      });
    });

    it('só F1.1 (isSuperAdmin sem grants): ADMIN comum -> NOT_EVALUATED GRANTS_UNAVAILABLE', () => {
      const user = { ...admin(), grants: undefined };
      delete (user as { grants?: unknown }).grants;
      expect(evaluate({ user })).toEqual({
        outcome: 'NOT_EVALUATED',
        reason: 'GRANTS_UNAVAILABLE',
      });
    });

    it.each([
      ['isSuperAdmin não booleano', { isSuperAdmin: 'true' }],
      ['grants não é lista', { grants: { 0: grant() } }],
      [
        'permissão fora do formato',
        { grants: [grant({ permissions: ['ADMIN'] })] },
      ],
      [
        'escopo desconhecido',
        { grants: [grant({ scope: { type: 'ALL', sellerIds: [] } })] },
      ],
      [
        'SELLERS sem vendedores',
        { grants: [grant({ scope: { type: 'SELLERS', sellerIds: [] } })] },
      ],
      [
        'OWN_STORE com sellerId',
        {
          grants: [
            grant({ scope: { type: 'OWN_STORE', sellerIds: [SELLER_A] } }),
          ],
        },
      ],
      ['expiresAt inválido', { grants: [grant({ expiresAt: 'amanhã' })] }],
      ['grantId inválido', { grants: [grant({ grantId: 'x' })] }],
    ])(
      'forma inesperada (%s) -> NOT_EVALUATED INVALID_CLAIMS',
      (_label, override) => {
        expect(evaluate({ user: admin(override) })).toEqual({
          outcome: 'NOT_EVALUATED',
          reason: 'INVALID_CLAIMS',
        });
      },
    );

    it('contrato novo com concessão compatível -> WOULD_ALLOW', () => {
      expect(evaluate()).toMatchObject({
        outcome: 'WOULD_ALLOW',
        reason: 'GRANT_COVERS',
        grantId: G1,
        roleKey: 'OPERATIONS',
        scopeType: 'GLOBAL',
      });
    });
  });

  describe('sujeito', () => {
    it('sem sessão -> NOT_EVALUATED NO_SESSION', () => {
      expect(evaluate({ user: undefined })).toEqual({
        outcome: 'NOT_EVALUATED',
        reason: 'NO_SESSION',
      });
    });

    it.each([
      ['CUSTOMER', [Role.CUSTOMER]],
      ['SELLER', [Role.SELLER]],
      ['CUSTOMER+SELLER', [Role.CUSTOMER, Role.SELLER]],
    ])(
      '%s com concessões forjadas na introspecção -> WOULD_DENY NOT_ADMIN (nenhuma permissão administrativa)',
      (_label, roles) => {
        expect(
          evaluate({ user: admin({ roles, isSuperAdmin: true }) }),
        ).toEqual({ outcome: 'WOULD_DENY', reason: 'NOT_ADMIN' });
      },
    );

    it('ADMIN não ativo -> WOULD_DENY ACCOUNT_NOT_ACTIVE', () => {
      expect(evaluate({ user: admin({ status: UserStatus.BLOCKED }) })).toEqual(
        {
          outcome: 'WOULD_DENY',
          reason: 'ACCOUNT_NOT_ACTIVE',
        },
      );
    });

    it('superadministrador apto -> WOULD_ALLOW SUPERADMIN, mesmo sem concessão', () => {
      expect(
        evaluate({ user: admin({ isSuperAdmin: true, grants: [] }) }),
      ).toEqual({
        outcome: 'WOULD_ALLOW',
        reason: 'SUPERADMIN',
      });
    });

    it('ADMIN comum sem a permissão -> WOULD_DENY PERMISSION_MISSING', () => {
      expect(
        evaluate({
          user: admin({
            grants: [grant({ permissions: ['catalog:product:read'] })],
          }),
        }),
      ).toEqual({ outcome: 'WOULD_DENY', reason: 'PERMISSION_MISSING' });
      expect(evaluate({ user: admin({ grants: [] }) })).toEqual({
        outcome: 'WOULD_DENY',
        reason: 'PERMISSION_MISSING',
      });
    });
  });

  describe('validade', () => {
    it('concessão expirada -> WOULD_DENY GRANT_EXPIRED', () => {
      expect(
        evaluate({
          user: admin({
            grants: [grant({ expiresAt: '2026-10-14T11:59:59.000Z' })],
          }),
        }),
      ).toEqual({ outcome: 'WOULD_DENY', reason: 'GRANT_EXPIRED' });
    });

    it('concessão com validade futura -> WOULD_ALLOW', () => {
      expect(
        evaluate({
          user: admin({
            grants: [grant({ expiresAt: '2026-10-15T00:00:00.000Z' })],
          }),
        }).outcome,
      ).toBe('WOULD_ALLOW');
    });

    it('concessão revogada: ausente da introspecção -> WOULD_DENY; marcada como revogada -> WOULD_DENY GRANT_REVOKED', () => {
      expect(evaluate({ user: admin({ grants: [] }) }).outcome).toBe(
        'WOULD_DENY',
      );
      expect(
        evaluate({
          user: admin({
            grants: [grant({ revokedAt: '2026-10-14T10:00:00.000Z' })],
          }),
        }),
      ).toEqual({ outcome: 'WOULD_DENY', reason: 'GRANT_REVOKED' });
    });

    it('uma concessão expirada não anula outra válida', () => {
      expect(
        evaluate({
          user: admin({
            grants: [
              grant({ expiresAt: '2026-01-01T00:00:00.000Z' }),
              grant({ grantId: G2 }),
            ],
          }),
        }),
      ).toMatchObject({ outcome: 'WOULD_ALLOW', grantId: G2 });
    });
  });

  describe('escopos', () => {
    const sellerRoute = required('sellers:seller:approve', {
      mode: 'SELLER',
      sellerIdParam: 'id',
    });

    it('GLOBAL cobre qualquer modo', () => {
      for (const scope of [
        { mode: 'PLATFORM' as const },
        { mode: 'COLLECTION' as const },
        { mode: 'SELLER_OWNED' as const },
        { mode: 'SELLER' as const, sellerIdParam: 'id' },
      ]) {
        const user = admin({
          grants: [grant({ permissions: ['sellers:seller:approve'] })],
        });
        expect(
          evaluate({
            user,
            requirement: required('sellers:seller:approve', scope),
            params: { id: SELLER_A },
          }).outcome,
        ).toBe('WOULD_ALLOW');
      }
    });

    it('SELLERS: cobre o vendedor listado e nega outro vendedor', () => {
      const user = admin({
        grants: [
          grant({
            permissions: ['sellers:seller:approve'],
            scope: { type: 'SELLERS', sellerIds: [SELLER_A] },
          }),
        ],
      });
      expect(
        evaluate({ user, requirement: sellerRoute, params: { id: SELLER_A } }),
      ).toMatchObject({
        outcome: 'WOULD_ALLOW',
        scopeType: 'SELLERS',
      });
      expect(
        evaluate({ user, requirement: sellerRoute, params: { id: SELLER_B } }),
      ).toEqual({
        outcome: 'WOULD_DENY',
        reason: 'SCOPE_NOT_COVERED',
      });
    });

    it('não combina permissão de uma concessão com o escopo de outra', () => {
      // G1: aprovar vendedor, mas só no vendedor A. G2: escopo B, mas outra permissão.
      const user = admin({
        grants: [
          grant({
            grantId: G1,
            permissions: ['sellers:seller:approve'],
            scope: { type: 'SELLERS', sellerIds: [SELLER_A] },
          }),
          grant({
            grantId: G2,
            permissions: ['catalog:product:approve'],
            scope: { type: 'SELLERS', sellerIds: [SELLER_B] },
          }),
        ],
      });
      expect(
        evaluate({ user, requirement: sellerRoute, params: { id: SELLER_B } }),
      ).toEqual({
        outcome: 'WOULD_DENY',
        reason: 'SCOPE_NOT_COVERED',
      });
    });

    it('SELLERS em listagem global -> WOULD_ALLOW só com filtro (requiresFilter)', () => {
      const user = admin({
        grants: [grant({ scope: { type: 'SELLERS', sellerIds: [SELLER_A] } })],
      });
      expect(evaluate({ user })).toMatchObject({
        outcome: 'WOULD_ALLOW',
        reason: 'SCOPE_FILTER_REQUIRED',
        requiresFilter: true,
      });
    });

    it('PLATFORM: só GLOBAL cobre; SELLERS -> WOULD_DENY', () => {
      const user = admin({
        grants: [
          grant({
            permissions: ['catalog:category:manage'],
            scope: { type: 'SELLERS', sellerIds: [SELLER_A] },
          }),
        ],
      });
      expect(
        evaluate({
          user,
          requirement: required('catalog:category:manage', {
            mode: 'PLATFORM',
          }),
        }),
      ).toEqual({ outcome: 'WOULD_DENY', reason: 'SCOPE_NOT_COVERED' });
    });

    it('SELLER_OWNED com escopo por vendedor -> NOT_EVALUATED (dono do recurso não resolvido nesta fase)', () => {
      const user = admin({
        grants: [
          grant({
            permissions: ['catalog:product:approve'],
            scope: { type: 'SELLERS', sellerIds: [SELLER_A] },
          }),
        ],
      });
      expect(
        evaluate({
          user,
          requirement: required('catalog:product:approve', {
            mode: 'SELLER_OWNED',
          }),
        }),
      ).toMatchObject({
        outcome: 'NOT_EVALUATED',
        reason: 'RESOURCE_SELLER_UNRESOLVED',
      });
    });

    it('OWN_STORE: sem loja confiável -> NOT_EVALUATED; com loja confiável compara com o alvo', () => {
      const user = admin({
        grants: [
          grant({
            permissions: ['sellers:seller:approve'],
            scope: { type: 'OWN_STORE', sellerIds: [] },
          }),
        ],
      });
      expect(
        evaluate({ user, requirement: sellerRoute, params: { id: SELLER_A } }),
      ).toMatchObject({
        outcome: 'NOT_EVALUATED',
        reason: 'OWN_STORE_UNRESOLVED',
      });
      expect(
        evaluate({
          user,
          requirement: sellerRoute,
          params: { id: SELLER_A },
          trustedOwnSellerId: SELLER_A,
        }),
      ).toMatchObject({ outcome: 'WOULD_ALLOW', scopeType: 'OWN_STORE' });
      expect(
        evaluate({
          user,
          requirement: sellerRoute,
          params: { id: SELLER_B },
          trustedOwnSellerId: SELLER_A,
        }),
      ).toEqual({ outcome: 'WOULD_DENY', reason: 'SCOPE_NOT_COVERED' });
    });

    it('OWN_STORE nunca usa sellerId do cliente: só o parâmetro da rota é comparado com a loja confiável', () => {
      const user = admin({
        grants: [
          grant({
            permissions: ['sellers:seller:approve'],
            scope: { type: 'OWN_STORE', sellerIds: [] },
          }),
        ],
      });
      // params traz o alvo; nenhuma outra fonte (body/query) é lida pelo avaliador.
      expect(
        evaluate({
          user,
          requirement: sellerRoute,
          params: { id: SELLER_B, sellerId: SELLER_B },
        }),
      ).toMatchObject({
        outcome: 'NOT_EVALUATED',
        reason: 'OWN_STORE_UNRESOLVED',
      });
    });

    it('id de rota inválido -> NOT_EVALUATED INVALID_RESOURCE_ID (o ValidationPipe responde 400 depois)', () => {
      const user = admin({
        grants: [
          grant({
            permissions: ['sellers:seller:approve'],
            scope: { type: 'SELLERS', sellerIds: [SELLER_A] },
          }),
        ],
      });
      expect(
        evaluate({
          user,
          requirement: sellerRoute,
          params: { id: 'nao-uuid' },
        }),
      ).toMatchObject({
        outcome: 'NOT_EVALUATED',
        reason: 'INVALID_RESOURCE_ID',
      });
    });
  });

  it('rota sem código no catálogo (pending): ADMIN comum -> NOT_EVALUATED; superadmin -> WOULD_ALLOW', () => {
    const pending = {
      kind: 'pending',
      reason: 'sem código',
    } as PermissionRequirement;
    expect(evaluate({ requirement: pending })).toEqual({
      outcome: 'NOT_EVALUATED',
      reason: 'PERMISSION_PENDING_CATALOG',
    });
    expect(
      evaluate({ requirement: pending, user: admin({ isSuperAdmin: true }) })
        .outcome,
    ).toBe('WOULD_ALLOW');
  });
});
