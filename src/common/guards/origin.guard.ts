import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { AppConfig } from '../../config/configuration';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Same CSRF defense as the other services: CORS (`enableCors`) only
 * controls what a browser is allowed to read back, not what it can send, so
 * a real Origin check on every mutating request is still required. No
 * /internal/* exemption here — this service exposes no /internal/* routes
 * of its own in this v1 (it is purely a client of identity-service's and
 * catalog-service's internal APIs, never a callee — see auth.constants.ts).
 */
@Injectable()
export class OriginGuard implements CanActivate {
  constructor(private readonly configService: ConfigService<AppConfig, true>) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (!MUTATING_METHODS.has(request.method.toUpperCase())) {
      return true;
    }

    const allowed = this.allowedOrigins(request);
    const origin = this.requestOrigin(request);

    if (!origin) {
      if (this.configService.get('nodeEnv', { infer: true }) === 'production') {
        throw new ForbiddenException('Missing Origin header');
      }
      return true;
    }

    if (!allowed.has(origin)) {
      throw new ForbiddenException('Origin is not allowed');
    }

    return true;
  }

  private requestOrigin(request: Request): string | null {
    const origin = request.headers.origin;
    if (typeof origin === 'string' && origin.length > 0) {
      return origin;
    }

    const referer = request.headers.referer;
    if (typeof referer === 'string' && referer.length > 0) {
      try {
        return new URL(referer).origin;
      } catch {
        return null;
      }
    }

    return null;
  }

  private allowedOrigins(request: Request): Set<string> {
    const allowed = new Set<string>([
      this.configService.get('frontendUrl', { infer: true }),
    ]);

    const host = request.get('host');
    if (host) {
      const forwardedProto = request.get('x-forwarded-proto');
      const protocol =
        typeof forwardedProto === 'string' && forwardedProto.length > 0
          ? forwardedProto.split(',')[0]!.trim()
          : request.protocol;
      allowed.add(`${protocol}://${host}`);
    }

    return allowed;
  }
}
