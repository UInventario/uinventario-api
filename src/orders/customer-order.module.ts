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
import { CustomerOrderShippingController } from './customer-order-shipping.controller';
import { CustomerOrderShippingRepository } from './customer-order-shipping.repository';
import { CustomerOrderShippingService } from './customer-order-shipping.service';

@Module({
  imports: [SessionModule, PosModule, ProductReservationModule],
  controllers: [CustomerOrderController, CustomerOrderShippingController],
  providers: [
    CustomerOrderRepository,
    CustomerOrderService,
    CustomerOrderEventBus,
    CustomerOrderShippingRepository,
    CustomerOrderShippingService,
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
