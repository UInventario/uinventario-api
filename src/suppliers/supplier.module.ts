import { Module } from '@nestjs/common';
import { SessionModule } from '../auth/session/session.module';
import { SupplierController } from './supplier.controller';
import { SupplierRepository } from './supplier.repository';
import { SupplierService } from './supplier.service';
import { SupplierProductController } from './supplier-product.controller';
import { SupplierProductRepository } from './supplier-product.repository';
import { SupplierProductService } from './supplier-product.service';
import { SupplierAccessGuard } from './supplier-access.guard';

@Module({
  imports: [SessionModule],
  controllers: [SupplierController, SupplierProductController],
  providers: [
    SupplierRepository,
    SupplierService,
    SupplierProductRepository,
    SupplierProductService,
    SupplierAccessGuard,
  ],
})
export class SupplierModule {}
