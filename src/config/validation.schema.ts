import Joi from 'joi';

export const validationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  PORT: Joi.number().port().default(3000),
  CORS_ORIGINS: Joi.string().default('http://localhost:4200'),
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
    .default('http://localhost:4200/restablecer'),
  PASSWORD_RESET_DELIVERY: Joi.string().valid('local', 'disabled').optional(),
  POS_TAX_RATES: Joi.string()
    .pattern(
      /^(?:[A-Z]{2}|DEFAULT)=(?:0|0\.\d{1,4}|1\.0{1,4})(?:,(?:[A-Z]{2}|DEFAULT)=(?:0|0\.\d{1,4}|1\.0{1,4}))*$/,
    )
    .default('MX=0.1600,CL=0.1900,DEFAULT=0.0000'),
});
