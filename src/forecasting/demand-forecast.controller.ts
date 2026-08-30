import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { PermissionGuard } from '../auth/authorization/permission.guard';
import { RequirePermissions } from '../auth/authorization/require-permissions.decorator';
import { SessionGuard } from '../auth/session/session.guard';
import type { AuthenticatedRequest } from '../auth/session/session.types';
import { DemandForecastService } from './demand-forecast.service';
import { GenerateDemandForecastDto } from './dto/generate-demand-forecast.dto';

@Controller('forecasting/demand')
@UseGuards(SessionGuard, PermissionGuard)
@RequirePermissions('SALES_MANAGE', 'INVENTORY_VIEW')
export class DemandForecastController {
  constructor(private readonly forecasts: DemandForecastService) {}

  @Get('latest')
  latest(@Req() request: AuthenticatedRequest) {
    const { principal } = request;
    return this.forecasts.latest(
      principal.tenant.id,
      principal.user.id,
      principal.context.branch!.id,
      principal.user.permissions.includes('TENANT_MANAGE'),
    );
  }

  @Post('runs')
  generate(
    @Req() request: AuthenticatedRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: GenerateDemandForecastDto,
  ) {
    const { principal } = request;
    return this.forecasts.generate({
      tenantId: principal.tenant.id,
      userId: principal.user.id,
      branchId: principal.context.branch!.id,
      administrator: principal.user.permissions.includes('TENANT_MANAGE'),
      horizonDays: dto.horizonDays,
      idempotencyKey: idempotencyKey ?? '',
    });
  }
}
