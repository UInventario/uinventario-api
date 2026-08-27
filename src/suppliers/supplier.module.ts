import { Module } from '@nestjs/common';
import { SessionModule } from '../auth/session/session.module';
import { PermissionGuard } from '../auth/authorization/permission.guard';
import { SupplierController } from './supplier.controller';
import { SupplierRepository } from './supplier.repository';
import { SupplierService } from './supplier.service';

@Module({
  imports: [SessionModule],
  controllers: [SupplierController],
  providers: [SupplierRepository, SupplierService, PermissionGuard],
})
export class SupplierModule {}
