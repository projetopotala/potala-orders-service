import { validateEnv } from './env.validation';

const baseEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://potala:potala@127.0.0.1:5432/potala_test',
  FRONTEND_URL: 'http://localhost:3000',
  PORT: '3004',
  IDENTITY_SERVICE_URL: 'http://localhost:3001',
  IDENTITY_SERVICE_API_KEY: 'test-identity-service-api-key-not-a-real-secret',
  CATALOG_SERVICE_URL: 'http://localhost:3003',
  CATALOG_SERVICE_API_KEY: 'test-catalog-service-api-key-not-a-real-secret',
  SELLERS_SERVICE_URL: 'http://localhost:3002',
  SELLERS_SERVICE_API_KEY: 'test-sellers-service-api-key-not-a-real-secret',
};

describe('validateEnv', () => {
  it('applies every default when only the required variables are set', () => {
    const config = validateEnv(baseEnv);

    expect(config).toEqual({
      nodeEnv: 'test',
      port: 3004,
      databaseUrl: baseEnv.DATABASE_URL,
      frontendUrl: 'http://localhost:3000',
      swaggerEnabled: true,
      logHttpBody: false,
      session: { cookieName: 'potala_session' },
      throttle: { ttlMs: 60_000, limit: 60 },
      identityService: {
        baseUrl: baseEnv.IDENTITY_SERVICE_URL,
        apiKey: baseEnv.IDENTITY_SERVICE_API_KEY,
        timeoutMs: 5000,
      },
      catalogService: {
        baseUrl: baseEnv.CATALOG_SERVICE_URL,
        apiKey: baseEnv.CATALOG_SERVICE_API_KEY,
        timeoutMs: 5000,
      },
      sellersService: {
        baseUrl: baseEnv.SELLERS_SERVICE_URL,
        apiKey: baseEnv.SELLERS_SERVICE_API_KEY,
        timeoutMs: 5000,
      },
    });
  });

  it('keeps the current full configuration valid', () => {
    const config = validateEnv({
      ...baseEnv,
      NODE_ENV: 'development',
      DIRECT_URL: 'postgresql://potala:potala@127.0.0.1:5432/potala_test',
      SESSION_COOKIE_NAME: 'potala_session',
      SWAGGER_ENABLED: 'true',
      LOG_HTTP_BODY: 'false',
      THROTTLE_TTL_MS: '60000',
      THROTTLE_LIMIT: '60',
      IDENTITY_SERVICE_TIMEOUT_MS: '5000',
      CATALOG_SERVICE_TIMEOUT_MS: '5000',
      SELLERS_SERVICE_TIMEOUT_MS: '5000',
    });

    expect(config.nodeEnv).toBe('development');
    expect(config.session.cookieName).toBe('potala_session');
    expect(config.identityService.timeoutMs).toBe(5000);
    expect(config.catalogService.timeoutMs).toBe(5000);
    expect(config.sellersService.timeoutMs).toBe(5000);
  });

  it('never enables HTTP body logging in production', () => {
    const config = validateEnv({
      ...baseEnv,
      NODE_ENV: 'production',
      LOG_HTTP_BODY: 'true',
    });
    expect(config.logHttpBody).toBe(false);
  });

  describe('NODE_ENV', () => {
    it.each(['development', 'test', 'production'])('accepts %s', (value) => {
      expect(validateEnv({ ...baseEnv, NODE_ENV: value }).nodeEnv).toBe(value);
    });

    it.each(['staging', 'prod', 'Development'])('rejects %s', (value) => {
      expect(() => validateEnv({ ...baseEnv, NODE_ENV: value })).toThrow(
        /NODE_ENV/,
      );
    });
  });

  describe('PORT', () => {
    it('accepts the edges of the TCP range', () => {
      expect(validateEnv({ ...baseEnv, PORT: '1' }).port).toBe(1);
      expect(validateEnv({ ...baseEnv, PORT: '65535' }).port).toBe(65535);
    });

    it.each(['0', '65536', '-1', '3004.5', 'abc', 'NaN', 'Infinity', '1e3'])(
      'rejects %s',
      (value) => {
        expect(() => validateEnv({ ...baseEnv, PORT: value })).toThrow(/PORT/);
      },
    );
  });

  describe('IDENTITY_SERVICE_URL / IDENTITY_SERVICE_API_KEY', () => {
    it('requires the URL (this service has no local session table to fall back on)', () => {
      const { IDENTITY_SERVICE_URL: _omitted, ...withoutUrl } = baseEnv;
      expect(() => validateEnv(withoutUrl)).toThrow(/IDENTITY_SERVICE_URL/);
    });

    it('requires the API key', () => {
      const { IDENTITY_SERVICE_API_KEY: _omitted, ...withoutKey } = baseEnv;
      expect(() => validateEnv(withoutKey)).toThrow(
        /IDENTITY_SERVICE_API_KEY/,
      );
    });

    it('strips a trailing slash from the configured URL', () => {
      const config = validateEnv({
        ...baseEnv,
        IDENTITY_SERVICE_URL: 'http://localhost:3001/',
      });
      expect(config.identityService.baseUrl).toBe('http://localhost:3001');
    });

    it('rejects a non-http(s) URL', () => {
      expect(() =>
        validateEnv({ ...baseEnv, IDENTITY_SERVICE_URL: 'ftp://localhost' }),
      ).toThrow(/IDENTITY_SERVICE_URL/);
    });
  });

  describe('CATALOG_SERVICE_URL / CATALOG_SERVICE_API_KEY', () => {
    it('requires the URL (this service has no local product/variant/stock data to fall back on)', () => {
      const { CATALOG_SERVICE_URL: _omitted, ...withoutUrl } = baseEnv;
      expect(() => validateEnv(withoutUrl)).toThrow(/CATALOG_SERVICE_URL/);
    });

    it('requires the API key', () => {
      const { CATALOG_SERVICE_API_KEY: _omitted, ...withoutKey } = baseEnv;
      expect(() => validateEnv(withoutKey)).toThrow(/CATALOG_SERVICE_API_KEY/);
    });

    it('strips a trailing slash from the configured URL', () => {
      const config = validateEnv({
        ...baseEnv,
        CATALOG_SERVICE_URL: 'http://localhost:3003/',
      });
      expect(config.catalogService.baseUrl).toBe('http://localhost:3003');
    });

    it('rejects a non-http(s) URL', () => {
      expect(() =>
        validateEnv({ ...baseEnv, CATALOG_SERVICE_URL: 'ftp://localhost' }),
      ).toThrow(/CATALOG_SERVICE_URL/);
    });
  });

  describe('SELLERS_SERVICE_URL / SELLERS_SERVICE_API_KEY', () => {
    it('requires the URL (the seller-orders endpoints cannot resolve a sellerId without it)', () => {
      const { SELLERS_SERVICE_URL: _omitted, ...withoutUrl } = baseEnv;
      expect(() => validateEnv(withoutUrl)).toThrow(/SELLERS_SERVICE_URL/);
    });

    it('requires the API key', () => {
      const { SELLERS_SERVICE_API_KEY: _omitted, ...withoutKey } = baseEnv;
      expect(() => validateEnv(withoutKey)).toThrow(/SELLERS_SERVICE_API_KEY/);
    });

    it('strips a trailing slash from the configured URL', () => {
      const config = validateEnv({
        ...baseEnv,
        SELLERS_SERVICE_URL: 'http://localhost:3002/',
      });
      expect(config.sellersService.baseUrl).toBe('http://localhost:3002');
    });

    it('rejects a non-http(s) URL', () => {
      expect(() =>
        validateEnv({ ...baseEnv, SELLERS_SERVICE_URL: 'ftp://localhost' }),
      ).toThrow(/SELLERS_SERVICE_URL/);
    });
  });

  describe('booleans', () => {
    it.each([
      ['true', true],
      ['TRUE', true],
      ['1', true],
      ['false', false],
      ['FALSE', false],
      ['0', false],
    ] as const)('parses %s', (value, expected) => {
      expect(
        validateEnv({ ...baseEnv, SWAGGER_ENABLED: value }).swaggerEnabled,
      ).toBe(expected);
    });

    it.each(['yes', 'no', 'on', 'off', 'sim', '2', 'truthy'])(
      'rejects the ambiguous value %s instead of coercing it',
      (value) => {
        expect(() =>
          validateEnv({ ...baseEnv, SWAGGER_ENABLED: value }),
        ).toThrow(/SWAGGER_ENABLED/);
      },
    );
  });

  describe('database URLs', () => {
    it('requires DATABASE_URL', () => {
      const { DATABASE_URL: _omitted, ...withoutDatabase } = baseEnv;
      expect(() => validateEnv(withoutDatabase)).toThrow(/DATABASE_URL/);
    });

    it('rejects a non-postgres DATABASE_URL', () => {
      expect(() =>
        validateEnv({ ...baseEnv, DATABASE_URL: 'mysql://user@host:3306/db' }),
      ).toThrow(/DATABASE_URL/);
    });

    it.each([
      ['wrong protocol', 'mysql://potala:sup3rs3cr3t@db.internal:3306/potala'],
      ['unparseable value', 'potala :sup3rs3cr3t@ db.internal'],
    ])('never echoes credentials in the %s error', (_case, value) => {
      let message = '';
      try {
        validateEnv({ ...baseEnv, DIRECT_URL: value });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('DIRECT_URL');
      expect(message).not.toContain('sup3rs3cr3t');
      expect(message).not.toContain('db.internal');
    });
  });

  describe('FRONTEND_URL', () => {
    it('keeps http and localhost working', () => {
      expect(
        validateEnv({ ...baseEnv, FRONTEND_URL: 'http://localhost:3000' })
          .frontendUrl,
      ).toBe('http://localhost:3000');
    });

    it.each([
      'localhost:3000',
      'ftp://localhost:3000',
      'http://localhost:3000/',
      'not a url',
    ])('rejects %s', (value) => {
      expect(() => validateEnv({ ...baseEnv, FRONTEND_URL: value })).toThrow(
        /FRONTEND_URL/,
      );
    });
  });
});
