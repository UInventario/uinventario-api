import { Module } from '@nestjs/common';
import { SessionModule } from '../auth/session/session.module';
import { CatalogController } from './catalog.controller';
import { CatalogRepository } from './catalog.repository';
import { CatalogService } from './catalog.service';
import { ProductAccessGuard } from './product-access.guard';

@Module({
  imports: [SessionModule],
  controllers: [CatalogController],
  providers: [CatalogRepository, CatalogService, ProductAccessGuard],
})
export class CatalogModule {}
