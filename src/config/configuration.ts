export type AppEnvironment = 'development' | 'test' | 'production';

export interface AppConfig {
  nodeEnv: AppEnvironment;
  port: number;
  databaseUrl: string;
  frontendUrl: string;
  swaggerEnabled: boolean;
  logHttpBody: boolean;
  /**
   * This service never issues or sets the session cookie itself (only
   * identity-service does, on login). It only needs to know which cookie
   * name to read off incoming requests before forwarding the raw token to
   * IdentityServiceClient.introspectSession — same reasoning as
   * sellers-service's and catalog-service's own `session` config.
   */
  session: {
    cookieName: string;
  };
  throttle: {
    ttlMs: number;
    limit: number;
  };
  /**
   * Both are hard dependencies: this service authenticates nothing without
   * identity-service (no local session table), and cannot resolve/validate a
   * single cart line without catalog-service (no local product/variant/stock
   * data either — see docs/internal-api-contract.md). This service exposes
   * no /internal/* routes of its own in this v1 — no other service calls
   * into it yet — so there is no local internalApiKey / internal throttle
   * group to configure here.
   */
  identityService: {
    baseUrl: string;
    apiKey: string;
    timeoutMs: number;
  };
  catalogService: {
    baseUrl: string;
    apiKey: string;
    timeoutMs: number;
  };
  /**
   * Needed only by the seller-orders read endpoints (GET /seller/orders,
   * GET /seller/orders/:id) — resolving which sellerId the authenticated
   * user acts as means calling sellers-service's own
   * GET /internal/sellers/membership/:userId, since this service has no
   * local membership table either.
   */
  sellersService: {
    baseUrl: string;
    apiKey: string;
    timeoutMs: number;
  };
}

export const APP_CONFIG = 'APP_CONFIG';
