import { Module } from '@nestjs/common';
import { PermissionGuard } from '../auth/authorization/permission.guard';
import { SessionModule } from '../auth/session/session.module';
import { PosModule } from '../pos/pos.module';
import { ProductReservationModule } from '../reservations/product-reservation.module';
import { CustomerOrderController } from './customer-order.controller';
import { CustomerOrderRepository } from './customer-order.repository';
import { CustomerOrderService } from './customer-order.service';

@Module({
  imports: [SessionModule, PosModule, ProductReservationModule],
  controllers: [CustomerOrderController],
  providers: [CustomerOrderRepository, CustomerOrderService, PermissionGuard],
})
export class CustomerOrderModule {}
