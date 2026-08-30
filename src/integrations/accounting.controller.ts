import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { PermissionGuard } from '../auth/authorization/permission.guard';
import { RequirePermissions } from '../auth/authorization/require-permissions.decorator';
import { SessionGuard } from '../auth/session/session.guard';
import type { AuthenticatedRequest } from '../auth/session/session.types';
import { AccountingService } from './accounting.service';
import { DeliverAccountingEventDto } from './dto/deliver-accounting-event.dto';
import { UpdateAccountingConfigDto } from './dto/update-accounting-config.dto';

@Controller('integrations/accounting/v1')
@UseGuards(SessionGuard, PermissionGuard)
@RequirePermissions('TENANT_MANAGE')
export class AccountingController {
  constructor(private readonly accounting: AccountingService) {}

  @Get('contract')
  contract() {
    return this.accounting.contract();
  }

  @Get('config')
  config(@Req() request: AuthenticatedRequest) {
    return this.accounting.getConfig(request.principal.tenant.id);
  }

  @Put('config')
  saveConfig(
    @Req() request: AuthenticatedRequest,
    @Body() dto: UpdateAccountingConfigDto,
  ) {
    return this.accounting.saveConfig({ ...this.context(request), dto });
  }

  @Post('events/generate')
  generate(@Req() request: AuthenticatedRequest) {
    return this.accounting.generate(this.context(request));
  }

  @Get('events')
  events(@Req() request: AuthenticatedRequest) {
    return this.accounting.list(request.principal.tenant.id);
  }

  @Post('events/:id/deliver')
  deliver(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) eventId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: DeliverAccountingEventDto,
  ) {
    return this.accounting.deliver({
      ...this.context(request),
      eventId,
      idempotencyKey: idempotencyKey ?? '',
      dto,
    });
  }

  @Post('events/:id/reconcile')
  reconcile(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) eventId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return this.accounting.reconcile({
      ...this.context(request),
      eventId,
      idempotencyKey: idempotencyKey ?? '',
    });
  }

  private context(request: AuthenticatedRequest) {
    return {
      tenantId: request.principal.tenant.id,
      userId: request.principal.user.id,
      correlationId: request.requestId!,
    };
  }
}
