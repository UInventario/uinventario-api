import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { join } from 'node:path';
import { RegistrationModule } from './auth/registration/registration.module';
import { appConfig } from './config/app.config';
import { databaseConfig } from './config/database.config';
import { validationSchema } from './config/validation.schema';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [appConfig, databaseConfig],
      validationSchema,
      validationOptions: { abortEarly: true, allowUnknown: true },
    }),
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
  ],
})
export class AppModule {}
