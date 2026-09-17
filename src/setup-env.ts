process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??=
  'postgresql://potala:potala@127.0.0.1:5432/potala_test';
process.env.FRONTEND_URL ??= 'http://localhost:3000';
process.env.PORT ??= '3004';
process.env.SESSION_COOKIE_NAME ??= 'potala_session';
process.env.SWAGGER_ENABLED ??= 'false';
process.env.LOG_HTTP_BODY ??= 'false';
process.env.THROTTLE_TTL_MS ??= '60000';
process.env.THROTTLE_LIMIT ??= '60';
process.env.IDENTITY_SERVICE_URL ??= 'http://localhost:3001';
process.env.IDENTITY_SERVICE_API_KEY ??= 'test-identity-api-key-not-a-real-secret';
process.env.IDENTITY_SERVICE_TIMEOUT_MS ??= '5000';
process.env.CATALOG_SERVICE_URL ??= 'http://localhost:3003';
process.env.CATALOG_SERVICE_API_KEY ??= 'test-catalog-api-key-not-a-real-secret';
process.env.CATALOG_SERVICE_TIMEOUT_MS ??= '5000';
