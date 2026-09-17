export const ROLES_KEY = 'roles';
export const IS_PUBLIC_KEY = 'isPublic';

export const API_GLOBAL_PREFIX = 'api/v1';

/**
 * Header carrying the shared secret on every outbound call this service
 * makes to identity-service's or catalog-service's own /internal/* routes.
 * This service exposes no /internal/* routes of its own in this v1 — no
 * other service calls into orders-service yet — so there is no local
 * InternalApiKeyGuard / INTERNAL_PATH_SEGMENT to define, same situation
 * catalog-service started in before orders-service existed.
 */
export const INTERNAL_API_KEY_HEADER = 'x-internal-api-key';
