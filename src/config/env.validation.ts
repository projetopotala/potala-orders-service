import { AppConfig, AppEnvironment } from './configuration';

const APP_ENVIRONMENTS: readonly AppEnvironment[] = [
  'development',
  'test',
  'production',
];

/** Plain base-10 integers only: rejects 1e3, 0x10, Infinity, NaN and decimals. */
const INTEGER_PATTERN = /^-?\d+$/;

const TRUE_VALUES = new Set(['true', '1']);
const FALSE_VALUES = new Set(['false', '0']);

const PORT_MIN = 1;
const PORT_MAX = 65535;
const THROTTLE_TTL_MS_MIN = 1;
const THROTTLE_TTL_MS_MAX = 86_400_000;
const THROTTLE_LIMIT_MIN = 1;
const THROTTLE_LIMIT_MAX = 1_000_000;

const POSTGRES_PROTOCOLS = new Set(['postgres:', 'postgresql:']);
const HTTP_PROTOCOLS = new Set(['http:', 'https:']);

function readString(
  env: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = env[name];
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function required(env: Record<string, unknown>, name: string): string {
  const value = readString(env, name);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Only accepts the canonical spellings. Anything else is a typo or a wrong
 * assumption, and silently coercing it to false is how a production flag such
 * as SWAGGER_ENABLED ends up disabled without anyone noticing.
 */
function optionalBoolean(
  env: Record<string, unknown>,
  name: string,
  fallback: boolean,
): boolean {
  const value = readString(env, name);
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.toLowerCase();
  if (TRUE_VALUES.has(normalized)) {
    return true;
  }
  if (FALSE_VALUES.has(normalized)) {
    return false;
  }
  throw new Error(
    `Invalid boolean environment variable: ${name} (expected true, false, 1 or 0)`,
  );
}

/** `max` is optional: some values have a floor from the domain but no ceiling. */
function optionalInteger(
  env: Record<string, unknown>,
  name: string,
  fallback: number,
  min: number,
  max?: number,
): number {
  const value = readString(env, name);
  if (value === undefined) {
    return fallback;
  }
  if (!INTEGER_PATTERN.test(value)) {
    throw new Error(
      `Invalid integer environment variable: ${name} (expected a whole number)`,
    );
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < min ||
    (max !== undefined && parsed > max)
  ) {
    const range = max === undefined ? `>= ${min}` : `${min}..${max}`;
    throw new Error(
      `Environment variable out of range: ${name} (expected ${range})`,
    );
  }
  return parsed;
}

/** Never echoes the value back: connection strings carry credentials. */
function assertPostgresUrl(value: string, name: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid environment variable: ${name} is not a valid URL`);
  }
  if (!POSTGRES_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(
      `Invalid environment variable: ${name} must use postgresql:// or postgres://`,
    );
  }
}

/**
 * OriginGuard compares this value literally against the Origin header, so a
 * trailing slash or a path would silently break CSRF checks and CORS.
 */
function readFrontendOrigin(env: Record<string, unknown>): string {
  const name = 'FRONTEND_URL';
  const value = required(env, name);

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid environment variable: ${name} is not a valid URL`);
  }
  if (!HTTP_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(
      `Invalid environment variable: ${name} must use http:// or https://`,
    );
  }
  if (value !== parsed.origin) {
    throw new Error(
      `Invalid environment variable: ${name} must be a bare origin such as ${parsed.origin} (no trailing slash, path or query)`,
    );
  }

  return parsed.origin;
}

/**
 * Bare origin, same shape as FRONTEND_URL. Required for both
 * IDENTITY_SERVICE_URL and CATALOG_SERVICE_URL: this service has no local
 * session table and no local product/variant/stock data, so it cannot
 * authenticate or validate a single checkout line without both dependencies
 * reachable.
 */
function readRequiredServiceOrigin(
  env: Record<string, unknown>,
  name: string,
): string {
  const value = required(env, name);

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid environment variable: ${name} is not a valid URL`);
  }
  if (!HTTP_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(
      `Invalid environment variable: ${name} must use http:// or https://`,
    );
  }
  // Trailing slash is tolerated (unlike FRONTEND_URL) and stripped, since this
  // value is only ever concatenated with a path by the two service clients.
  return value.replace(/\/+$/, '');
}

export function validateEnv(env: Record<string, unknown>): AppConfig {
  const nodeEnvRaw = readString(env, 'NODE_ENV') ?? 'development';
  if (!APP_ENVIRONMENTS.includes(nodeEnvRaw as AppEnvironment)) {
    throw new Error(
      `Invalid NODE_ENV: ${nodeEnvRaw} (expected ${APP_ENVIRONMENTS.join(', ')})`,
    );
  }

  const nodeEnv = nodeEnvRaw as AppEnvironment;
  const isProduction = nodeEnv === 'production';
  const logHttpBodyRequested = optionalBoolean(env, 'LOG_HTTP_BODY', false);

  const databaseUrl = required(env, 'DATABASE_URL');
  assertPostgresUrl(databaseUrl, 'DATABASE_URL');

  // Prisma only needs DIRECT_URL for migrate/introspect, never at runtime, so
  // it stays optional here and is merely format-checked when provided.
  const directUrl = readString(env, 'DIRECT_URL');
  if (directUrl !== undefined) {
    assertPostgresUrl(directUrl, 'DIRECT_URL');
  }

  const identityServiceUrl = readRequiredServiceOrigin(
    env,
    'IDENTITY_SERVICE_URL',
  );
  const identityServiceApiKey = required(env, 'IDENTITY_SERVICE_API_KEY');

  const catalogServiceUrl = readRequiredServiceOrigin(
    env,
    'CATALOG_SERVICE_URL',
  );
  const catalogServiceApiKey = required(env, 'CATALOG_SERVICE_API_KEY');

  return {
    nodeEnv,
    port: optionalInteger(env, 'PORT', 3004, PORT_MIN, PORT_MAX),
    databaseUrl,
    frontendUrl: readFrontendOrigin(env),
    swaggerEnabled: optionalBoolean(env, 'SWAGGER_ENABLED', !isProduction),
    logHttpBody: isProduction ? false : logHttpBodyRequested,
    session: {
      cookieName: readString(env, 'SESSION_COOKIE_NAME') ?? 'potala_session',
    },
    throttle: {
      ttlMs: optionalInteger(
        env,
        'THROTTLE_TTL_MS',
        60_000,
        THROTTLE_TTL_MS_MIN,
        THROTTLE_TTL_MS_MAX,
      ),
      limit: optionalInteger(
        env,
        'THROTTLE_LIMIT',
        60,
        THROTTLE_LIMIT_MIN,
        THROTTLE_LIMIT_MAX,
      ),
    },
    identityService: {
      baseUrl: identityServiceUrl,
      apiKey: identityServiceApiKey,
      timeoutMs: optionalInteger(
        env,
        'IDENTITY_SERVICE_TIMEOUT_MS',
        5000,
        100,
        60_000,
      ),
    },
    catalogService: {
      baseUrl: catalogServiceUrl,
      apiKey: catalogServiceApiKey,
      timeoutMs: optionalInteger(
        env,
        'CATALOG_SERVICE_TIMEOUT_MS',
        5000,
        100,
        60_000,
      ),
    },
  };
}
