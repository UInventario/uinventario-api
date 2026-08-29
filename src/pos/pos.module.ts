import { Module } from '@nestjs/common';
import { SessionModule } from '../auth/session/session.module';
import { PosAccessGuard } from './pos-access.guard';
import { PosController } from './pos.controller';
import { PosRepository } from './pos.repository';
import { PosService } from './pos.service';
import { SalesRepository } from './sales.repository';
import { CashRegisterShiftRepository } from './cash-register-shift.repository';
import { CashRegisterShiftService } from './cash-register-shift.service';
import { CashRegisterMovementRepository } from './cash-register-movement.repository';
import { CashRegisterMovementService } from './cash-register-movement.service';
import { CashRegisterClosureRepository } from './cash-register-closure.repository';
import { CashRegisterClosureService } from './cash-register-closure.service';
import { PermissionGuard } from '../auth/authorization/permission.guard';
import { PaymentAuthorizationService } from './payment-authorization.service';
import { SalesCashReportRepository } from './sales-cash-report.repository';
import { SalesCashReportService } from './sales-cash-report.service';
import { SaleReceiptController } from './sale-receipt.controller';
import { SaleReceiptRepository } from './sale-receipt.repository';
import { SaleReceiptService } from './sale-receipt.service';
import {
  SALE_RECEIPT_EMAIL_ADAPTER,
  SimulatorSaleReceiptEmailAdapter,
} from './sale-receipt-email.adapter';
import { SaleReturnController } from './sale-return.controller';
import { SaleReturnRepository } from './sale-return.repository';
import { SaleReturnService } from './sale-return.service';
import { SaleReturnSettlementRepository } from './sale-return-settlement.repository';
import { PaymentRefundService } from './payment-refund.service';
import { SuspendedSaleController } from './suspended-sale.controller';
import { SuspendedSaleRepository } from './suspended-sale.repository';
import { SuspendedSaleService } from './suspended-sale.service';
import { PosPeripheralController } from './pos-peripheral.controller';
import { PosPeripheralRepository } from './pos-peripheral.repository';
import { PosPeripheralService } from './pos-peripheral.service';
import {
  POS_PERIPHERAL_ADAPTER,
  SimulatorPosPeripheralAdapter,
} from './pos-peripheral.adapter';
import { PriceListModule } from '../pricing/price-list.module';
import { CustomerModule } from '../customers/customer.module';
import { CustomerCreditPaymentController } from './customer-credit-payment.controller';
import { CustomerCreditPaymentRepository } from './customer-credit-payment.repository';
import { CustomerCreditPaymentService } from './customer-credit-payment.service';

@Module({
  imports: [SessionModule, PriceListModule, CustomerModule],
  controllers: [
    PosController,
    SaleReceiptController,
    SaleReturnController,
    SuspendedSaleController,
    PosPeripheralController,
    CustomerCreditPaymentController,
  ],
  providers: [
    PosRepository,
    SalesRepository,
    CashRegisterShiftRepository,
    CashRegisterShiftService,
    CashRegisterMovementRepository,
    CashRegisterMovementService,
    CashRegisterClosureRepository,
    CashRegisterClosureService,
    PermissionGuard,
    PaymentAuthorizationService,
    SalesCashReportRepository,
    SalesCashReportService,
    SaleReceiptRepository,
    SaleReceiptService,
    SaleReturnRepository,
    SaleReturnSettlementRepository,
    SaleReturnService,
    PaymentRefundService,
    SuspendedSaleRepository,
    SuspendedSaleService,
    PosPeripheralRepository,
    PosPeripheralService,
    CustomerCreditPaymentRepository,
    CustomerCreditPaymentService,
    SimulatorPosPeripheralAdapter,
    {
      provide: POS_PERIPHERAL_ADAPTER,
      useExisting: SimulatorPosPeripheralAdapter,
    },
    SimulatorSaleReceiptEmailAdapter,
    {
      provide: SALE_RECEIPT_EMAIL_ADAPTER,
      useExisting: SimulatorSaleReceiptEmailAdapter,
    },
    PosService,
    PosAccessGuard,
  ],
  exports: [PosService],
})
export class PosModule {}
