import { Module } from '@nestjs/common';
import { SessionModule } from '../auth/session/session.module';
import { PosAccessGuard } from './pos-access.guard';
import { PosController } from './pos.controller';
import { PosRepository } from './pos.repository';
import { PosService } from './pos.service';
import { SalesRepository } from './sales.repository';

@Module({
  imports: [SessionModule],
  controllers: [PosController],
  providers: [PosRepository, SalesRepository, PosService, PosAccessGuard],
})
export class PosModule {}
