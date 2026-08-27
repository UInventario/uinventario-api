import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { appConfig } from './config/app.config';
import { validationSchema } from './config/validation.schema';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [appConfig],
      validationSchema,
      validationOptions: { abortEarly: true, allowUnknown: true },
    }),
    HealthModule,
  ],
})
export class AppModule {}
