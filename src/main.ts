import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { configureApp } from './security/configure-app';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: new ConsoleLogger({ colors: false, compact: true, json: true }),
  });
  const config = app.get(ConfigService);
  configureApp(app);

  await app.listen(config.getOrThrow<number>('app.port'));
}

void bootstrap();
