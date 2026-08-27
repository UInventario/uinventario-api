import { Module } from '@nestjs/common';
import { PermissionGuard } from '../auth/authorization/permission.guard';
import { SessionModule } from '../auth/session/session.module';
import { PurchaseOrderController } from './purchase-order.controller';
import { PurchaseOrderRepository } from './purchase-order.repository';
import { PurchaseOrderService } from './purchase-order.service';
import {
  PurchaseOrderDelivery,
  SimulatedPurchaseOrderDelivery,
} from './purchase-order.delivery';

@Module({
  imports: [SessionModule],
  controllers: [PurchaseOrderController],
  providers: [
    PurchaseOrderRepository,
    PurchaseOrderService,
    PermissionGuard,
    {
      provide: PurchaseOrderDelivery,
      useClass: SimulatedPurchaseOrderDelivery,
    },
  ],
})
export class ProcurementModule {}
