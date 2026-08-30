import { Module } from '@nestjs/common';
import { PermissionGuard } from '../auth/authorization/permission.guard';
import { SessionModule } from '../auth/session/session.module';
import { DemandForecastController } from './demand-forecast.controller';
import { DemandForecastRepository } from './demand-forecast.repository';
import { DemandForecastService } from './demand-forecast.service';

@Module({
  imports: [SessionModule],
  controllers: [DemandForecastController],
  providers: [DemandForecastRepository, DemandForecastService, PermissionGuard],
})
export class DemandForecastModule {}
