import {
  INestApplication,
  RequestMethod,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpAdapterHost } from '@nestjs/core';
import type { NextFunction, Response } from 'express';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import type { RequestContext } from './request-context';
import { SanitizedExceptionFilter } from './sanitized-exception.filter';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export function configureApp(app: INestApplication): void {
  const config = app.get(ConfigService);
  const origins = config.getOrThrow<string[]>('app.corsOrigins');
  const isProduction =
    config.getOrThrow<string>('app.environment') === 'production';

  if (isProduction) {
    const express = app.getHttpAdapter().getInstance() as {
      set(setting: string, value: number): void;
    };
    express.set('trust proxy', 1);
  }

  app.setGlobalPrefix('api/v1', {
    exclude: [
      { path: 'health/live', method: RequestMethod.GET },
      { path: 'health/ready', method: RequestMethod.GET },
    ],
  });
  app.use(
    helmet({
      strictTransportSecurity: isProduction ? undefined : false,
    }),
  );
  app.use((request: RequestContext, response: Response, next: NextFunction) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader(
      'Permissions-Policy',
      'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
    );
    const suppliedRequestId = request.header('x-request-id');
    request.requestId =
      suppliedRequestId && REQUEST_ID_PATTERN.test(suppliedRequestId)
        ? suppliedRequestId
        : randomUUID();
    response.setHeader('X-Request-Id', request.requestId);

    const origin = request.header('origin');
    if (
      !SAFE_METHODS.has(request.method) &&
      origin !== undefined &&
      !origins.includes(origin)
    ) {
      response.status(403).json({
        code: 'ORIGIN_NOT_ALLOWED',
        message: 'El origen de la solicitud no está autorizado.',
      });
      return;
    }
    next();
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new SanitizedExceptionFilter(app.get(HttpAdapterHost)));
  app.enableCors({
    origin: origins,
    credentials: true,
  });
  app.enableShutdownHooks();
}
