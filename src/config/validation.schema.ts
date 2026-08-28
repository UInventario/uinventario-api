import Joi from 'joi';

const originList = Joi.string()
  .custom((value: string, helpers) => {
    const origins = value
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
    if (origins.length === 0) return helpers.error('origins.empty');
    for (const origin of origins) {
      try {
        const parsed = new URL(origin);
        if (
          !['http:', 'https:'].includes(parsed.protocol) ||
          parsed.origin !== origin ||
          parsed.username ||
          parsed.password
        ) {
          return helpers.error('origins.invalid');
        }
      } catch {
        return helpers.error('origins.invalid');
      }
    }
    return origins.join(',');
  })
  .messages({
    'origins.empty': '{{#label}} must contain at least one origin',
    'origins.invalid':
      '{{#label}} must contain comma-separated HTTP(S) origins without paths or credentials',
  });

const secureOriginList = originList
  .custom((value: string, helpers) =>
    value.split(',').every((origin) => new URL(origin).protocol === 'https:')
      ? value
      : helpers.error('origins.insecure'),
  )
  .messages({
    'origins.insecure':
      '{{#label}} must contain only HTTPS origins in production',
  });

export const validationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  DEPLOY_ENV: Joi.when('NODE_ENV', {
    is: 'production',
    then: Joi.string().valid('dev', 'prod').required(),
    otherwise: Joi.string().valid('local', 'dev', 'prod').default('local'),
  }),
  PORT: Joi.number().port().default(3000),
  CORS_ORIGINS: originList.when('NODE_ENV', {
    is: 'production',
    then: secureOriginList.required(),
    otherwise: originList.default('http://localhost:4200'),
  }),
  DATABASE_URL: Joi.string()
    .uri({ scheme: ['mysql'] })
    .required(),
  DB_MIGRATIONS_RUN: Joi.boolean().default(false),
  SESSION_COOKIE_NAME: Joi.string()
    .pattern(/^[A-Za-z0-9_-]+$/)
    .default('uinventario_session'),
  SESSION_TTL_MINUTES: Joi.number().integer().min(5).max(10_080).default(480),
  PASSWORD_RESET_TTL_MINUTES: Joi.number()
    .integer()
    .min(5)
    .max(1440)
    .default(30),
  PASSWORD_RESET_PUBLIC_URL: Joi.string()
    .uri()
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.string()
        .uri({ scheme: ['https'] })
        .required(),
      otherwise: Joi.string()
        .uri()
        .default('http://localhost:4200/restablecer'),
    }),
  PASSWORD_RESET_DELIVERY: Joi.string().valid('local', 'disabled').optional(),
  POS_TAX_RATES: Joi.string()
    .pattern(
      /^(?:[A-Z]{2}|DEFAULT)=(?:0|0\.\d{1,4}|1\.0{1,4})(?:,(?:[A-Z]{2}|DEFAULT)=(?:0|0\.\d{1,4}|1\.0{1,4}))*$/,
    )
    .default('MX=0.1600,CL=0.1900,DEFAULT=0.0000'),
});
