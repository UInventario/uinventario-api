import { Module } from '@nestjs/common';
import { PermissionGuard } from '../auth/authorization/permission.guard';
import { SessionModule } from '../auth/session/session.module';
import { ProductReservationController } from './product-reservation.controller';
import { ProductReservationRepository } from './product-reservation.repository';
import { ProductReservationService } from './product-reservation.service';

@Module({
  imports: [SessionModule],
  controllers: [ProductReservationController],
  providers: [
    ProductReservationRepository,
    ProductReservationService,
    PermissionGuard,
  ],
})
export class ProductReservationModule {}
