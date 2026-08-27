import { Module } from '@nestjs/common';
import { SessionModule } from '../auth/session/session.module';
import { PermissionGuard } from '../auth/authorization/permission.guard';
import { SupplierController } from './supplier.controller';
import { SupplierRepository } from './supplier.repository';
import { SupplierService } from './supplier.service';
import { SupplierProductController } from './supplier-product.controller';
import { SupplierProductRepository } from './supplier-product.repository';
import { SupplierProductService } from './supplier-product.service';

@Module({
  imports: [SessionModule],
  controllers: [SupplierController, SupplierProductController],
  providers: [
    SupplierRepository,
    SupplierService,
    SupplierProductRepository,
    SupplierProductService,
    PermissionGuard,
  ],
})
export class SupplierModule {}
