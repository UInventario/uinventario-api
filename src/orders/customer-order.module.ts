import { Module } from '@nestjs/common';
import { PermissionGuard } from '../auth/authorization/permission.guard';
import { SessionModule } from '../auth/session/session.module';
import { PosModule } from '../pos/pos.module';
import { ProductReservationModule } from '../reservations/product-reservation.module';
import { CustomerOrderController } from './customer-order.controller';
import {
  CUSTOMER_ORDER_CARRIER_ADAPTER,
  SimulatorCustomerOrderCarrierAdapter,
} from './customer-order-carrier.adapter';
import { CustomerOrderRepository } from './customer-order.repository';
import { CustomerOrderService } from './customer-order.service';
import { CustomerOrderEventBus } from './customer-order-event.bus';

@Module({
  imports: [SessionModule, PosModule, ProductReservationModule],
  controllers: [CustomerOrderController],
  providers: [
    CustomerOrderRepository,
    CustomerOrderService,
    CustomerOrderEventBus,
    PermissionGuard,
    SimulatorCustomerOrderCarrierAdapter,
    {
      provide: CUSTOMER_ORDER_CARRIER_ADAPTER,
      useExisting: SimulatorCustomerOrderCarrierAdapter,
    },
  ],
  exports: [CustomerOrderService, CustomerOrderEventBus],
})
export class CustomerOrderModule {}
