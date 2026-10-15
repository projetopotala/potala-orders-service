import { createHash } from 'crypto';
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { AppConfig } from '../../config/configuration';
import { RequestWithAuth } from '../types/authenticated-user';
import { PERMISSION_CATALOG_MIRROR_VERSION } from './permission-catalog.mirror';
import { ShadowDecision, evaluatePermission } from './permission-evaluator';
import {
  PERMISSION_REQUIREMENT_KEY,
  PermissionRequirement,
} from './require-permission.decorator';

export const PERMISSION_SHADOW_SERVICE = 'orders-service';
export const PERMISSION_SHADOW_LOG_EVENT = 'permission_shadow';

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** Uma linha de log por decisão; só metadados técnicos controlados. */
export interface PermissionShadowRecord {
  event: typeof PERMISSION_SHADOW_LOG_EVENT;
  service: string;
  catalogVersion: string;
  method: string;
  /** Padrão da rota (ex.: /api/v1/admin/sellers/:id/approve), nunca a URL real. */
  route: string;
  handler: string;
  permission: string | null;
  scopeMode: string | null;
  outcome: ShadowDecision['outcome'];
  reason: ShadowDecision['reason'];
  grantId?: string;
  roleKey?: string | null;
  scopeType?: string;
  requiresFilter?: boolean;
  /** Pseudônimo estável do usuário (hash truncado), nunca o id nem o e-mail. */
  userRef: string | null;
  correlationId: string | null;
}

function userReference(user: unknown): string | null {
  const id = (user as { id?: unknown } | undefined)?.id;
  if (typeof id !== 'string' || id.length === 0) {
    return null;
  }
  return createHash('sha256')
    .update(`permission-shadow:${id}`)
    .digest('hex')
    .slice(0, 16);
}

function correlationId(request: RequestWithAuth): string | null {
  for (const name of ['x-correlation-id', 'x-request-id']) {
    const raw = request.headers?.[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (
      typeof value === 'string' &&
      CORRELATION_ID_PATTERN.test(value.trim())
    ) {
      return value.trim();
    }
  }
  return null;
}

/**
 * F1.3 -- avaliação das permissões granulares em MODO SOMBRA.
 *
 * É um interceptor (e não um guard) de propósito: interceptores só rodam
 * depois que TODOS os guards -- globais e de rota (SessionAuthGuard,
 * RolesGuard, SellerContextGuard...) -- já autorizaram a requisição. Por
 * construção ele não consegue liberar nada que os guards negaram nem mudar
 * um 401/403: só observa requisições já autorizadas pela regra atual.
 *
 * Garantias:
 * - PERMISSION_SHADOW_MODE=false (padrão): retorna `next.handle()` sem ler
 *   metadados, sem avaliar e sem registrar nada.
 * - ativado: avalia de forma síncrona e pura (sem I/O, sem nova chamada de
 *   introspecção, sem consulta ao banco) e registra uma linha estruturada.
 * - qualquer erro da avaliação ou do registro é engolido (EVALUATION_ERROR):
 *   a requisição segue exatamente como seguiria sem este interceptor.
 * - a resposta HTTP nunca é alterada.
 */
@Injectable()
export class PermissionShadowInterceptor implements NestInterceptor {
  private readonly logger = new Logger('PermissionShadow');
  private readonly enabled: boolean;

  constructor(
    private readonly reflector: Reflector,
    configService: ConfigService<AppConfig, true>,
  ) {
    let enabled = false;
    try {
      enabled =
        configService.get('permissionShadow', { infer: true })?.enabled ===
        true;
    } catch {
      enabled = false;
    }
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!this.enabled || context.getType() !== 'http') {
      return next.handle();
    }
    try {
      this.observe(context);
    } catch {
      // Nunca propaga: nem a falha do registro de erro muda a requisição.
    }
    return next.handle();
  }

  private observe(context: ExecutionContext): void {
    const requirement = this.reflector.getAllAndOverride<
      PermissionRequirement | undefined
    >(PERMISSION_REQUIREMENT_KEY, [context.getHandler(), context.getClass()]);
    if (!requirement) {
      return;
    }

    const request = context.switchToHttp().getRequest<RequestWithAuth>();
    let decision: ShadowDecision;
    try {
      decision = evaluatePermission({
        user: request.authUser,
        requirement,
        params: request.params as Record<string, unknown> | undefined,
        trustedOwnSellerId: request.sellerContext?.sellerId,
        now: new Date(),
      });
    } catch {
      decision = { outcome: 'EVALUATION_ERROR', reason: 'EVALUATOR_EXCEPTION' };
    }

    const route = (request as { route?: { path?: unknown } }).route?.path;
    const record: PermissionShadowRecord = {
      event: PERMISSION_SHADOW_LOG_EVENT,
      service: PERMISSION_SHADOW_SERVICE,
      catalogVersion: PERMISSION_CATALOG_MIRROR_VERSION,
      method: typeof request.method === 'string' ? request.method : 'UNKNOWN',
      route: typeof route === 'string' ? route : '(unknown)',
      handler: `${context.getClass().name}.${context.getHandler().name}`,
      permission:
        requirement.kind === 'required' ? requirement.permission : null,
      scopeMode:
        requirement.kind === 'required' ? requirement.scope.mode : null,
      outcome: decision.outcome,
      reason: decision.reason,
      ...(decision.grantId ? { grantId: decision.grantId } : {}),
      ...(decision.roleKey !== undefined ? { roleKey: decision.roleKey } : {}),
      ...(decision.scopeType ? { scopeType: decision.scopeType } : {}),
      ...(decision.requiresFilter ? { requiresFilter: true } : {}),
      userRef: userReference(request.authUser),
      correlationId: correlationId(request),
    };
    this.logger.log(JSON.stringify(record));
  }
}
