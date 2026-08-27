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

@Module({
  imports: [SessionModule],
  controllers: [PosController],
  providers: [
    PosRepository,
    SalesRepository,
    CashRegisterShiftRepository,
    CashRegisterShiftService,
    CashRegisterMovementRepository,
    CashRegisterMovementService,
    PosService,
    PosAccessGuard,
  ],
})
export class PosModule {}
