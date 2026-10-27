import { z } from 'zod';

/**
 * Environment configuration. Secrets come ONLY from the environment / secrets manager,
 * never from database configuration records.
 */
const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().default(4000),
    APP_NAME: z.string().default('The K'),
    DATABASE_URL: z.string().url(),
    /** Neon direct (non-pooled) connection string. Preferred over DATABASE_URL when set (see db/database-url.ts). */
    DATABASE_URL_UNPOOLED: z.string().url().optional(),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),
    CORS_ORIGINS: z.string().default('http://localhost:3000'),

    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 chars'),
    JWT_STEPUP_SECRET: z.string().min(32, 'JWT_STEPUP_SECRET must be at least 32 chars'),
    ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().min(60).max(3600).default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    STEPUP_TTL_SEC: z.coerce.number().int().min(60).max(900).default(300),
    /** 32-byte key, base64. Used for AES-256-GCM encryption of MFA secrets. Load from KMS/vault in production. */
    DATA_ENCRYPTION_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32, 'DATA_ENCRYPTION_KEY must be 32 bytes base64'),
    /** Id of DATA_ENCRYPTION_KEY, written into every ciphertext so keys can be rotated. */
    DATA_ENCRYPTION_KEY_ID: z.string().regex(/^[A-Za-z0-9_-]{1,16}$/).default('k1'),
    /** Older keys that may still be needed to decrypt: "k0:base64,k-1:base64". Remove after `npm run keys:rotate`. */
    DATA_ENCRYPTION_KEYS_PREVIOUS: z.string().optional(),
    /** 32-byte key (base64) for blind indexes on encrypted columns. Defaults to a key derived from HASH_PEPPER. */
    BLIND_INDEX_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32, 'BLIND_INDEX_KEY must be 32 bytes base64').optional(),
    /** HMAC pepper for OTP and refresh-token hashing. */
    HASH_PEPPER: z.string().min(32),

    SMS_PROVIDER: z.enum(['dev', 'msg91', 'twilio']).default('dev'),
    COOKIE_SECURE: z
      .string()
      .default('false')
      .transform((v) => v === 'true'),
    TRUST_PROXY: z
      .string()
      .default('false')
      .transform((v) => v === 'true'),

    /** Real-money execution stays OFF until legal/broker/exchange requirements are satisfied. */
    LIVE_TRADING_ENABLED: z
      .string()
      .default('false')
      .transform((v) => v === 'true'),
    MARKET_FEED: z.enum(['simulated']).default('simulated'),
    /** 'config' = use trading.marketHours; 'always_open' = ignore sessions (development/testing only). */
    MARKET_HOURS: z.enum(['config', 'always_open']).default('config'),
    THROTTLE_SCALE: z.coerce.number().int().min(1).max(100).default(1),
    /** Where daily log archives are written. In production use WORM storage (S3 Object Lock etc.). */
    LOG_ARCHIVE_DIR: z.string().default('./log-archive'),
    LOG_MAINTENANCE: z.enum(['on', 'off']).default('on'),
    LOG_FORMAT: z.enum(['json', 'pretty']).optional(),
    LOG_REQUESTS_STDOUT: z.enum(['true', 'false']).default('false'),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production') {
      if (env.SMS_PROVIDER === 'dev')
        ctx.addIssue({ code: 'custom', message: 'SMS_PROVIDER=dev is not allowed in production' });
      if (env.MARKET_HOURS !== 'config') ctx.addIssue({ code: 'custom', message: 'MARKET_HOURS must be "config" in production' });
      if (env.THROTTLE_SCALE !== 1) ctx.addIssue({ code: 'custom', message: 'THROTTLE_SCALE must be 1 in production' });
      if (!env.COOKIE_SECURE) ctx.addIssue({ code: 'custom', message: 'COOKIE_SECURE must be true in production' });
      if (env.JWT_ACCESS_SECRET === env.JWT_STEPUP_SECRET)
        ctx.addIssue({ code: 'custom', message: 'JWT secrets must differ' });
    }
    if (env.LIVE_TRADING_ENABLED) {
      ctx.addIssue({
        code: 'custom',
        message:
          'LIVE_TRADING_ENABLED is not supported in this build: no licensed broker/exchange integration is configured.',
      });
    }
  });

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;
export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join('.') || 'env'}: ${i.message}`).join('\n  ');
      throw new Error(`Invalid environment configuration:\n  ${msg}`);
    }
    cached = parsed.data;
  }
  return cached;
}

/** For tests only. */
export function resetEnvCache() {
  cached = undefined;
}
