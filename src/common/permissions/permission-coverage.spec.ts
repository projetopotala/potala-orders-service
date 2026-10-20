import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { IS_PUBLIC_KEY, ROLES_KEY } from '../constants/auth.constants';
import { Role } from '../types/identity-enums';
import { isMirroredPermission } from './permission-catalog.mirror';
import {
  PERMISSION_REQUIREMENT_KEY,
  PermissionRequirement,
} from './require-permission.decorator';

/**
 * F1.3 -- cobertura de permissões das rotas deste serviço.
 *
 * Descobre TODOS os controllers (src/**\/*.controller.ts) em vez de uma
 * lista fixa: uma rota administrativa nova sem @RequirePermission nem
 * @PermissionPending faz este teste falhar, para que a ativação futura
 * (F1.6) não deixe endpoint sem declaração.
 */
type Ctor = { name: string; prototype: Record<string, unknown> };

interface RouteInfo {
  key: string;
  controller: string;
  handler: string;
  roles: Role[] | undefined;
  isPublic: boolean;
  guards: unknown[];
  requirement: PermissionRequirement | undefined;
}

function controllerFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      return controllerFiles(full);
    }
    return entry.endsWith('.controller.ts') ? [full] : [];
  });
}

function joinPath(...parts: Array<string | undefined>): string {
  const path = parts
    .filter((part): part is string => typeof part === 'string')
    .flatMap((part) => part.split('/'))
    .filter((segment) => segment.length > 0)
    .join('/');
  return `/${path}`;
}

function collectRoutes(): RouteInfo[] {
  const routes: RouteInfo[] = [];
  for (const file of controllerFiles(join(__dirname, '..', '..'))) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(file) as Record<string, unknown>;
    for (const value of Object.values(mod)) {
      if (typeof value !== 'function') {
        continue;
      }
      const ctor = value as unknown as Ctor;
      const base = Reflect.getMetadata(PATH_METADATA, ctor) as
        string | undefined;
      if (base === undefined) {
        continue;
      }
      for (const handler of Object.getOwnPropertyNames(ctor.prototype)) {
        const fn = ctor.prototype[handler];
        if (handler === 'constructor' || typeof fn !== 'function') {
          continue;
        }
        const method = Reflect.getMetadata(METHOD_METADATA, fn) as
          RequestMethod | undefined;
        if (method === undefined) {
          continue;
        }
        const path = Reflect.getMetadata(PATH_METADATA, fn) as
          string | undefined;
        const meta = <T>(key: string): T | undefined =>
          (Reflect.getMetadata(key, fn) as T | undefined) ??
          (Reflect.getMetadata(key, ctor) as T | undefined);
        routes.push({
          key: `${RequestMethod[method]} ${joinPath(base, path)}`,
          controller: ctor.name,
          handler,
          roles: meta<Role[]>(ROLES_KEY),
          isPublic: meta<boolean>(IS_PUBLIC_KEY) === true,
          guards: [
            ...((Reflect.getMetadata(GUARDS_METADATA, ctor) as unknown[]) ??
              []),
            ...((Reflect.getMetadata(GUARDS_METADATA, fn) as unknown[]) ?? []),
          ],
          requirement: meta<PermissionRequirement>(PERMISSION_REQUIREMENT_KEY),
        });
      }
    }
  }
  return routes;
}

type Expected =
  | { permission: string; mode: string; sellerIdParam?: string }
  | { pending: true };

/** Matriz pretendida (F1.3). Mudança de rota administrativa exige atualizar aqui. */
const EXPECTED_ADMIN_MATRIX: Record<string, Expected> = {
  'GET /admin/orders': { permission: 'orders:order:read', mode: 'COLLECTION' },
  'GET /admin/returns': {
    permission: 'aftersales:return:read',
    mode: 'COLLECTION',
  },
  'PATCH /admin/returns/:id/approve': {
    permission: 'aftersales:return:approve',
    mode: 'SELLER_OWNED',
  },
  'PATCH /admin/returns/:id/reject': {
    permission: 'aftersales:return:approve',
    mode: 'SELLER_OWNED',
  },
  'GET /admin/claims': {
    permission: 'aftersales:claim:read',
    mode: 'COLLECTION',
  },
  'GET /admin/claims/:id': {
    permission: 'aftersales:claim:read',
    mode: 'SELLER_OWNED',
  },
  'POST /admin/claims/:id/messages': {
    permission: 'aftersales:claim:update',
    mode: 'SELLER_OWNED',
  },
  'POST /admin/claims/:id/evidence': {
    permission: 'aftersales:claim:update',
    mode: 'SELLER_OWNED',
  },
  'PATCH /admin/claims/:id/escalate': {
    permission: 'aftersales:claim:update',
    mode: 'SELLER_OWNED',
  },
  'PATCH /admin/claims/:id/resolve': {
    permission: 'aftersales:claim:update',
    mode: 'SELLER_OWNED',
  },
  'PATCH /admin/claims/:id/close': {
    permission: 'aftersales:claim:update',
    mode: 'SELLER_OWNED',
  },
  'POST /admin/claims/:id/dispute': {
    permission: 'aftersales:dispute:update',
    mode: 'SELLER_OWNED',
  },
  'POST /admin/returns/:id/dispute': {
    permission: 'aftersales:dispute:update',
    mode: 'SELLER_OWNED',
  },
  'GET /admin/disputes': {
    permission: 'aftersales:dispute:read',
    mode: 'COLLECTION',
  },
  'GET /admin/disputes/:id': {
    permission: 'aftersales:dispute:read',
    mode: 'SELLER_OWNED',
  },
  'POST /admin/disputes/:id/decisions': {
    permission: 'aftersales:dispute:update',
    mode: 'SELLER_OWNED',
  },
  'GET /admin/coupons': {
    permission: 'marketing:coupon:read',
    mode: 'PLATFORM',
  },
  'POST /admin/coupons': {
    permission: 'marketing:coupon:create',
    mode: 'PLATFORM',
  },
  'PATCH /admin/coupons/:id': {
    permission: 'marketing:coupon:update',
    mode: 'PLATFORM',
  },
  'PATCH /admin/coupons/:id/activate': {
    permission: 'marketing:coupon:update',
    mode: 'PLATFORM',
  },
  'PATCH /admin/coupons/:id/deactivate': {
    permission: 'marketing:coupon:deactivate',
    mode: 'PLATFORM',
  },
  'DELETE /admin/coupons/:id': { pending: true },
};

describe('F1.3 -- cobertura de permissões granulares das rotas (orders-service)', () => {
  const routes = collectRoutes();
  const adminRoutes = routes.filter((route) =>
    (route.roles ?? []).includes(Role.ADMIN),
  );

  it('descobre as rotas do serviço', () => {
    expect(routes.length).toBeGreaterThan(0);
    expect(adminRoutes.length).toBe(Object.keys(EXPECTED_ADMIN_MATRIX).length);
  });

  it('toda rota administrativa declara permissão (ou lacuna explícita do catálogo)', () => {
    const missing = adminRoutes
      .filter((route) => !route.requirement)
      .map((route) => `${route.key} (${route.controller}.${route.handler})`);
    expect(missing).toEqual([]);
  });

  it('o conjunto de rotas administrativas é exatamente o da matriz', () => {
    expect(adminRoutes.map((route) => route.key).sort()).toEqual(
      Object.keys(EXPECTED_ADMIN_MATRIX).sort(),
    );
  });

  it('cada rota administrativa usa a permissão e o modo de escopo da matriz', () => {
    for (const route of adminRoutes) {
      const expected = EXPECTED_ADMIN_MATRIX[route.key];
      const requirement = route.requirement as PermissionRequirement;
      if ('pending' in expected) {
        expect({ key: route.key, kind: requirement.kind }).toEqual({
          key: route.key,
          kind: 'pending',
        });
        continue;
      }
      expect(requirement.kind).toBe('required');
      if (requirement.kind !== 'required') {
        continue;
      }
      expect({
        key: route.key,
        permission: requirement.permission,
        mode: requirement.scope.mode,
        ...(requirement.scope.mode === 'SELLER'
          ? { sellerIdParam: requirement.scope.sellerIdParam }
          : {}),
      }).toEqual({ key: route.key, ...expected });
      expect(isMirroredPermission(requirement.permission)).toBe(true);
    }
  });

  it('rotas administrativas mantêm @Roles(ADMIN) exatamente como antes e nunca são públicas', () => {
    for (const route of adminRoutes) {
      expect({ key: route.key, roles: route.roles }).toEqual({
        key: route.key,
        roles: [Role.ADMIN],
      });
      expect(route.isPublic).toBe(false);
    }
  });

  it('nenhuma rota de cliente, vendedor, pública ou interna recebe permissão granular', () => {
    const others = routes.filter(
      (route) => !(route.roles ?? []).includes(Role.ADMIN),
    );
    expect(
      others.filter((route) => route.requirement).map((route) => route.key),
    ).toEqual([]);
    // Nenhuma rota não-administrativa passou a aceitar ADMIN.
    for (const route of others) {
      expect(route.roles ?? []).not.toContain(Role.ADMIN);
    }
  });

  it('regressão "vendedor também compra": rotas de comprador seguem aceitando CUSTOMER e SELLER, sem permissão granular', () => {
    const buyerRoutes = routes.filter((route) =>
      ['OrdersController', 'CustomerClaimsController'].includes(
        route.controller,
      ),
    );
    expect(buyerRoutes.length).toBeGreaterThan(0);
    for (const route of buyerRoutes) {
      expect({ key: route.key, roles: route.roles }).toEqual({
        key: route.key,
        roles: [Role.CUSTOMER, Role.SELLER],
      });
      expect(route.requirement).toBeUndefined();
    }
    expect(buyerRoutes.map((route) => route.key)).toContain(
      'POST /orders/checkout',
    );
  });

  it('rotas da loja (/seller/*) seguem só SELLER, sem permissão granular nem acesso ADMIN', () => {
    const sellerRoutes = routes.filter((route) =>
      route.key.split(' ')[1].startsWith('/seller/'),
    );
    expect(sellerRoutes.length).toBeGreaterThan(0);
    for (const route of sellerRoutes) {
      expect(route.roles).toEqual([Role.SELLER]);
      expect(route.requirement).toBeUndefined();
    }
  });
});
