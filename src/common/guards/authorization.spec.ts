import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { OriginGuard } from './origin.guard';
import { ROLES_KEY } from '../constants/auth.constants';
import { Role, UserStatus } from '../types/identity-enums';
import { RequestWithAuth } from '../types/authenticated-user';
import { createConfigMock } from '../../test-utils/prisma.mock';
import { AppConfig } from '../../config/configuration';

function createContext(request: Partial<RequestWithAuth>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

describe('Authorization foundation', () => {
  it('prevents SELLER from accessing CUSTOMER-only routes such as checkout', () => {
    const reflector = {
      getAllAndOverride: jest.fn((key: string) =>
        key === ROLES_KEY ? [Role.CUSTOMER] : false,
      ),
    } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    const context = createContext({
      authUser: {
        id: 'u1',
        email: 's@test.com',
        status: UserStatus.ACTIVE,
        roles: [Role.SELLER],
      },
    });

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('allows CUSTOMER to access CUSTOMER-only routes', () => {
    const reflector = {
      getAllAndOverride: jest.fn((key: string) =>
        key === ROLES_KEY ? [Role.CUSTOMER] : false,
      ),
    } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    const context = createContext({
      authUser: {
        id: 'u2',
        email: 'c@test.com',
        status: UserStatus.ACTIVE,
        roles: [Role.CUSTOMER],
      },
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('rejects mutating requests from a foreign origin', () => {
    const guard = new OriginGuard(
      createConfigMock() as unknown as ConfigService<AppConfig, true>,
    );
    const request = {
      method: 'POST',
      originalUrl: '/api/v1/orders/checkout',
      headers: { origin: 'https://evil.example' },
      get: () => 'localhost:3004',
      protocol: 'http',
    };
    expect(() => guard.canActivate(createContext(request as never))).toThrow(
      ForbiddenException,
    );
  });

  it('allows mutating requests from FRONTEND_URL', () => {
    const guard = new OriginGuard(
      createConfigMock() as unknown as ConfigService<AppConfig, true>,
    );
    const request = {
      method: 'POST',
      originalUrl: '/api/v1/orders/checkout',
      headers: { origin: 'http://localhost:3000' },
      get: () => 'localhost:3004',
      protocol: 'http',
    };
    expect(guard.canActivate(createContext(request as never))).toBe(true);
  });

  it('allows GET requests regardless of origin (read-only, no CSRF risk)', () => {
    const guard = new OriginGuard(
      createConfigMock() as unknown as ConfigService<AppConfig, true>,
    );
    const request = {
      method: 'GET',
      originalUrl: '/api/v1/orders',
      headers: { origin: 'https://evil.example' },
      get: () => 'localhost:3004',
      protocol: 'http',
    };
    expect(guard.canActivate(createContext(request as never))).toBe(true);
  });
});
