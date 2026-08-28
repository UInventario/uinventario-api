import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import { join } from 'node:path';
import { RegistrationModule } from './auth/registration/registration.module';
import { SessionModule } from './auth/session/session.module';
import { appConfig } from './config/app.config';
import { databaseConfig } from './config/database.config';
import { sessionConfig } from './config/session.config';
import { posConfig } from './config/pos.config';
import { passwordResetConfig } from './config/password-reset.config';
import { CatalogModule } from './catalog/catalog.module';
import { validationSchema } from './config/validation.schema';
import { HealthModule } from './health/health.module';
import { InventoryModule } from './inventory/inventory.module';
import { OnboardingModule } from './onboarding/onboarding.module';
import { PosModule } from './pos/pos.module';
import { PasswordResetModule } from './auth/password-reset/password-reset.module';
import { AuditModule } from './audit/audit.module';
import { OrganizationModule } from './organization/organization.module';
import { AccessControlModule } from './identity/access-control/access-control.module';
import { SupplierModule } from './suppliers/supplier.module';
import { ProcurementModule } from './procurement/procurement.module';
import { CustomerModule } from './customers/customer.module';
import { ProductReservationModule } from './reservations/product-reservation.module';
import { OfflineSyncModule } from './offline-sync/offline-sync.module';
import { DataExportModule } from './data-exports/data-export.module';
import { SecurityThrottlerGuard } from './security/security-throttler.guard';
import { ObservabilityModule } from './observability/observability.module';
import { PrivacyModule } from './privacy/privacy.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [
        appConfig,
        databaseConfig,
        sessionConfig,
        posConfig,
        passwordResetConfig,
      ],
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
    ObservabilityModule,
    RegistrationModule,
    SessionModule,
    PasswordResetModule,
    AuditModule,
    OnboardingModule,
    OrganizationModule,
    AccessControlModule,
    CatalogModule,
    SupplierModule,
    ProcurementModule,
    CustomerModule,
    ProductReservationModule,
    OfflineSyncModule,
    InventoryModule,
    PosModule,
    DataExportModule,
    PrivacyModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: SecurityThrottlerGuard }],
})
export class AppModule {}
