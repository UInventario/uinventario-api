import { Module } from '@nestjs/common';
import { SessionModule } from '../auth/session/session.module';
import { CatalogController } from './catalog.controller';
import { CatalogRepository } from './catalog.repository';
import { CatalogService } from './catalog.service';
import { ProductAccessGuard } from './product-access.guard';
import { CatalogClassificationController } from './catalog-classification.controller';

@Module({
  imports: [SessionModule],
  controllers: [CatalogController, CatalogClassificationController],
  providers: [CatalogRepository, CatalogService, ProductAccessGuard],
})
export class CatalogModule {}
