import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../constants/auth.constants';
import { AppConfig } from '../../config/configuration';
import { IdentityServiceClient } from '../../clients/identity-service.client';
import { RequestWithAuth } from '../types/authenticated-user';

/**
 * Network-based, same pattern as sellers-service's and catalog-service's own
 * SessionAuthGuard: this service has no local Session table, reads the same
 * -named session cookie directly off the request (there is no api-gateway
 * route for orders-service yet either — see README.md) and resolves it via
 * identity-service's POST /internal/sessions/introspect. Once api-gateway
 * centralizes this, this guard is the piece that gets replaced.
 */
@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly identityServiceClient: IdentityServiceClient,
    private readonly configService: ConfigService<AppConfig, true>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithAuth>();
    const cookieName = this.configService.get('session', {
      infer: true,
    }).cookieName;
    const token = request.cookies?.[cookieName] as string | undefined;

    if (!token) {
      throw new UnauthorizedException('Authentication required');
    }

    const authUser = await this.identityServiceClient.introspectSession(token);
    if (!authUser) {
      throw new UnauthorizedException('Invalid or expired session');
    }

    request.authUser = authUser;
    return true;
  }
}
