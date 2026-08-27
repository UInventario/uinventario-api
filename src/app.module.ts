import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ConfigService } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import { join } from 'node:path';
import { RegistrationModule } from './auth/registration/registration.module';
import { SessionModule } from './auth/session/session.module';
import { appConfig } from './config/app.config';
import { databaseConfig } from './config/database.config';
import { sessionConfig } from './config/session.config';
import { CatalogModule } from './catalog/catalog.module';
import { validationSchema } from './config/validation.schema';
import { HealthModule } from './health/health.module';
import { InventoryModule } from './inventory/inventory.module';
import { OnboardingModule } from './onboarding/onboarding.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [appConfig, databaseConfig, sessionConfig],
      validationSchema,
      validationOptions: { abortEarly: true, allowUnknown: true },
    }),
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 100 }]),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'mysql',
        url: config.getOrThrow<string>('database.url'),
        charset: 'utf8mb4',
        entities: [join(__dirname, '**', '*.entity.{js,ts}')],
        migrations: [join(__dirname, 'database', 'migrations', '*.{js,ts}')],
        migrationsRun: config.getOrThrow<boolean>('database.migrationsRun'),
        synchronize: false,
        retryAttempts: 3,
      }),
    }),
    HealthModule,
    RegistrationModule,
    SessionModule,
    OnboardingModule,
    CatalogModule,
    InventoryModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
