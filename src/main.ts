import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);
  const origins = config.getOrThrow<string[]>('app.corsOrigins');

  app.enableCors({
    origin: origins,
    credentials: true,
  });
  app.enableShutdownHooks();

  await app.listen(config.getOrThrow<number>('app.port'));
}

void bootstrap();
