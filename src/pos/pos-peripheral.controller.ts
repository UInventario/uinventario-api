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
import { RequireAnyPermission } from '../auth/authorization/require-any-permission.decorator';
import { RequirePermissions } from '../auth/authorization/require-permissions.decorator';
import { SessionGuard } from '../auth/session/session.guard';
import type { AuthenticatedRequest } from '../auth/session/session.types';
import { OpenCashDrawerDto } from './dto/open-cash-drawer.dto';
import { UpdatePosPeripheralProfileDto } from './dto/update-pos-peripheral-profile.dto';
import { PosAccessGuard } from './pos-access.guard';
import { PosPeripheralService } from './pos-peripheral.service';

@Controller('pos/peripherals')
@UseGuards(SessionGuard, PosAccessGuard, PermissionGuard)
export class PosPeripheralController {
  constructor(private readonly peripherals: PosPeripheralService) {}

  @Get('profile')
  @RequireAnyPermission('SALE_REPRINT', 'CASH_DRAWER_OPEN')
  profile(@Req() request: AuthenticatedRequest) {
    return this.peripherals.getProfile(this.context(request));
  }

  @Put('profile')
  @RequirePermissions('TENANT_MANAGE')
  updateProfile(
    @Req() request: AuthenticatedRequest,
    @Body() dto: UpdatePosPeripheralProfileDto,
  ) {
    return this.peripherals.updateProfile(this.context(request), dto);
  }

  @Post('receipts/:saleId/prints')
  @RequirePermissions('SALE_REPRINT')
  printReceipt(
    @Req() request: AuthenticatedRequest,
    @Param('saleId', ParseUUIDPipe) saleId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return this.peripherals.printReceipt(
      this.context(request),
      saleId,
      idempotencyKey,
    );
  }

  @Post('cash-drawer/openings')
  @RequirePermissions('CASH_DRAWER_OPEN')
  openDrawer(
    @Req() request: AuthenticatedRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: OpenCashDrawerDto,
  ) {
    return this.peripherals.openDrawer(this.context(request), {
      ...dto,
      idempotencyKey,
    });
  }

  private context(request: AuthenticatedRequest) {
    return {
      tenantId: request.principal.tenant.id,
      branchId: request.principal.context.branch!.id,
      cashRegisterId: request.principal.context.cashRegister!.id,
      userId: request.principal.user.id,
      correlationId: request.requestId!,
    };
  }
}
