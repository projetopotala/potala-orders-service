/**
 * Same mechanism as the other services' redact.ts, trimmed to the generic
 * auth-adjacent keys any service might see in a request body. Checkout
 * bodies here do carry personal data (recipient name, address) but, same as
 * every other service in this project, only auth-adjacent fields are
 * redacted — addresses are treated the same as the DTOs identity-service
 * already logs unredacted (e.g. registration payloads).
 */
const SENSITIVE_KEYS = new Set([
  'password',
  'passwordhash',
  'token',
  'sessiontoken',
  'cookie',
  'cookies',
  'authorization',
  'x-internal-api-key',
]);

export function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item));
  }

  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) {
        output[key] = '[REDACTED]';
      } else {
        output[key] = redactSensitive(nested);
      }
    }
    return output;
  }

  return value;
}
