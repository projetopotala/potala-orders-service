import { CallHandler, ExecutionContext, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import { AppConfig } from '../../config/configuration';
import { Role, UserStatus } from '../types/identity-enums';
import {
  PERMISSION_SHADOW_SERVICE,
  PermissionShadowInterceptor,
  PermissionShadowRecord,
} from './permission-shadow.interceptor';
import {
  PERMISSION_REQUIREMENT_KEY,
  PermissionRequirement,
} from './require-permission.decorator';

const SELLER_A = '0a000000-0000-4000-8000-00000000000a';
const GRANT_ID = '10000000-0000-4000-8000-000000000001';
const USER_ID = '99999999-9999-4999-8999-999999999999';

class FakeController {
  approve() {
    return 'ok';
  }
}

function config(enabled: unknown): ConfigService<AppConfig, true> {
  return {
    get: jest.fn((key: string) =>
      key === 'permissionShadow' ? { enabled } : undefined,
    ),
  } as unknown as ConfigService<AppConfig, true>;
}

function setup(enabled: unknown, requirement?: PermissionRequirement) {
  const reflector = {
    getAllAndOverride: jest.fn((key: string) =>
      key === PERMISSION_REQUIREMENT_KEY ? requirement : undefined,
    ),
  } as unknown as Reflector;
  const interceptor = new PermissionShadowInterceptor(
    reflector,
    config(enabled),
  );
  const log = jest
    .spyOn(Logger.prototype, 'log')
    .mockImplementation(() => undefined);
  return { interceptor, reflector, log };
}

function httpContext(request: Record<string, unknown>): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => FakeController.prototype.approve,
    getClass: () => FakeController,
  } as unknown as ExecutionContext;
}

function next(): CallHandler & { handle: jest.Mock } {
  const response = of({ status: 'resposta original' });
  return { handle: jest.fn(() => response) };
}

const REQUIREMENT: PermissionRequirement = {
  kind: 'required',
  permission: 'sellers:seller:approve',
  scope: { mode: 'SELLER', sellerIdParam: 'id' },
};

function adminRequest(user: Record<string, unknown> = {}) {
  return {
    method: 'PATCH',
    route: { path: '/api/v1/admin/sellers/:id/approve' },
    params: { id: SELLER_A },
    headers: {
      cookie: 'potala_session=TOKEN-SECRETO-NAO-LOGAR',
      authorization: 'Bearer TOKEN-SECRETO-NAO-LOGAR',
      'x-internal-api-key': 'CHAVE-INTERNA-NAO-LOGAR',
      'x-correlation-id': 'req-123',
    },
    cookies: { potala_session: 'TOKEN-SECRETO-NAO-LOGAR' },
    body: { cpf: '123.456.789-00', reason: 'documento 12.345.678/0001-90' },
    authUser: {
      id: USER_ID,
      email: 'admin.real@exemplo.test',
      status: UserStatus.ACTIVE,
      roles: [Role.ADMIN],
      isSuperAdmin: false,
      grants: [
        {
          grantId: GRANT_ID,
          roleId: '30000000-0000-4000-8000-000000000003',
          roleKey: 'CURATION',
          permissions: ['sellers:seller:approve'],
          scope: { type: 'GLOBAL', sellerIds: [] },
          expiresAt: null,
        },
      ],
      ...user,
    },
  };
}

function lastRecord(log: jest.SpyInstance): PermissionShadowRecord {
  const [line] = log.mock.calls.at(-1) as [string];
  return JSON.parse(line) as PermissionShadowRecord;
}

describe('F1.3 -- PermissionShadowInterceptor', () => {
  afterEach(() => jest.restoreAllMocks());

  it('desativado (padrão): não lê metadados, não avalia, não registra e repassa a mesma resposta', async () => {
    const { interceptor, reflector, log } = setup(false, REQUIREMENT);
    const handler = next();
    const result = interceptor.intercept(httpContext(adminRequest()), handler);
    expect(interceptor.isEnabled()).toBe(false);
    expect(reflector.getAllAndOverride).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(handler.handle).toHaveBeenCalledTimes(1);
    expect(result).toBe(handler.handle.mock.results[0].value);
    await expect(lastValueFrom(result)).resolves.toEqual({
      status: 'resposta original',
    });
  });

  it.each([undefined, 'true', 1, null])(
    'flag com valor não booleano (%p) -> desativado',
    (value) => {
      expect(setup(value).interceptor.isEnabled()).toBe(false);
    },
  );

  it('configuração ilegível -> desativado (nunca quebra a inicialização)', () => {
    const broken = {
      get: () => {
        throw new Error('config');
      },
    } as unknown as ConfigService<AppConfig, true>;
    expect(
      new PermissionShadowInterceptor(new Reflector(), broken).isEnabled(),
    ).toBe(false);
  });

  it('ativado sem permissão declarada na rota: não registra nada', () => {
    const { interceptor, log } = setup(true, undefined);
    const handler = next();
    interceptor.intercept(httpContext(adminRequest()), handler);
    expect(log).not.toHaveBeenCalled();
    expect(handler.handle).toHaveBeenCalledTimes(1);
  });

  it('ativado: registra uma linha estruturada e repassa a mesma resposta', async () => {
    const { interceptor, log } = setup(true, REQUIREMENT);
    const handler = next();
    const result = interceptor.intercept(httpContext(adminRequest()), handler);
    expect(log).toHaveBeenCalledTimes(1);
    expect(lastRecord(log)).toEqual({
      event: 'permission_shadow',
      service: PERMISSION_SHADOW_SERVICE,
      catalogVersion: '2026-10-14.1',
      method: 'PATCH',
      route: '/api/v1/admin/sellers/:id/approve',
      handler: 'FakeController.approve',
      permission: 'sellers:seller:approve',
      scopeMode: 'SELLER',
      outcome: 'WOULD_ALLOW',
      reason: 'GRANT_COVERS',
      grantId: GRANT_ID,
      roleKey: 'CURATION',
      scopeType: 'GLOBAL',
      userRef: expect.stringMatching(/^[0-9a-f]{16}$/),
      correlationId: 'req-123',
    });
    expect(result).toBe(handler.handle.mock.results[0].value);
    await expect(lastValueFrom(result)).resolves.toEqual({
      status: 'resposta original',
    });
  });

  it('o registro não contém cookie, token, chave interna, corpo, documento, e-mail nem id do usuário', () => {
    const { interceptor, log } = setup(true, REQUIREMENT);
    interceptor.intercept(httpContext(adminRequest()), next());
    const line = log.mock.calls[0][0] as string;
    for (const secret of [
      'TOKEN-SECRETO',
      'CHAVE-INTERNA',
      'potala_session',
      '123.456.789-00',
      '12.345.678/0001-90',
      'admin.real@exemplo.test',
      USER_ID,
      SELLER_A,
    ]) {
      expect(line).not.toContain(secret);
    }
  });

  it('ADMIN autorizado pela regra antiga sem a permissão -> segue; registra WOULD_DENY', () => {
    const { interceptor, log } = setup(true, REQUIREMENT);
    const handler = next();
    interceptor.intercept(httpContext(adminRequest({ grants: [] })), handler);
    expect(handler.handle).toHaveBeenCalledTimes(1);
    expect(lastRecord(log)).toMatchObject({
      outcome: 'WOULD_DENY',
      reason: 'PERMISSION_MISSING',
    });
  });

  it('introspecção antiga -> segue; registra NOT_EVALUATED', () => {
    const { interceptor, log } = setup(true, REQUIREMENT);
    const request = adminRequest();
    const legacy = { ...request.authUser } as Record<string, unknown>;
    delete legacy.isSuperAdmin;
    delete legacy.grants;
    const handler = next();
    interceptor.intercept(
      httpContext({ ...request, authUser: legacy }),
      handler,
    );
    expect(handler.handle).toHaveBeenCalledTimes(1);
    expect(lastRecord(log)).toMatchObject({
      outcome: 'NOT_EVALUATED',
      reason: 'LEGACY_INTROSPECTION',
    });
  });

  it('erro do avaliador -> EVALUATION_ERROR registrado e a requisição segue igual', async () => {
    const { interceptor, log } = setup(true, REQUIREMENT);
    const exploding = {};
    Object.defineProperty(exploding, 'roles', {
      get() {
        throw new Error('falha inesperada com dado sensível TOKEN-SECRETO');
      },
    });
    const handler = next();
    const result = interceptor.intercept(
      httpContext({ ...adminRequest(), authUser: exploding }),
      handler,
    );
    expect(lastRecord(log)).toMatchObject({
      outcome: 'EVALUATION_ERROR',
      reason: 'EVALUATOR_EXCEPTION',
    });
    expect(log.mock.calls[0][0]).not.toContain('TOKEN-SECRETO');
    await expect(lastValueFrom(result)).resolves.toEqual({
      status: 'resposta original',
    });
  });

  it('falha do próprio log não interrompe a requisição', () => {
    const { interceptor, log } = setup(true, REQUIREMENT);
    log.mockImplementation(() => {
      throw new Error('log indisponível');
    });
    const handler = next();
    expect(() =>
      interceptor.intercept(httpContext(adminRequest()), handler),
    ).not.toThrow();
    expect(handler.handle).toHaveBeenCalledTimes(1);
  });

  it('contexto não-HTTP é ignorado', () => {
    const { interceptor, log } = setup(true, REQUIREMENT);
    const handler = next();
    interceptor.intercept(
      { getType: () => 'rpc' } as unknown as ExecutionContext,
      handler,
    );
    expect(log).not.toHaveBeenCalled();
    expect(handler.handle).toHaveBeenCalledTimes(1);
  });

  it('correlation id inválido não é registrado', () => {
    const { interceptor, log } = setup(true, REQUIREMENT);
    const request = adminRequest();
    request.headers['x-correlation-id'] = 'abc\ninjetado';
    interceptor.intercept(httpContext(request), next());
    expect(lastRecord(log).correlationId).toBeNull();
  });
});
