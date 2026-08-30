import {
  Body,
  Controller,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { PermissionGuard } from '../auth/authorization/permission.guard';
import { RequirePermissions } from '../auth/authorization/require-permissions.decorator';
import { SessionGuard } from '../auth/session/session.guard';
import type { AuthenticatedRequest } from '../auth/session/session.types';
import { SendSaleReceiptDto } from './dto/send-sale-receipt.dto';
import { PosAccessGuard } from './pos-access.guard';
import { SaleReceiptService } from './sale-receipt.service';

@Controller('pos/sales')
@UseGuards(SessionGuard, PosAccessGuard, PermissionGuard)
@RequirePermissions('SALE_REPRINT')
export class SaleReceiptController {
  constructor(private readonly receipts: SaleReceiptService) {}

  @Post(':saleId/receipt/reprints')
  @HttpCode(200)
  reprint(
    @Req() request: AuthenticatedRequest,
    @Param('saleId', ParseUUIDPipe) saleId: string,
  ) {
    return this.receipts.reprint({
      tenantId: request.principal.tenant.id,
      branchId: request.principal.context.branch!.id,
      saleId,
      userId: request.principal.user.id,
      correlationId: request.requestId!,
    });
  }

  @Post(':saleId/receipt/deliveries')
  @HttpCode(200)
  send(
    @Req() request: AuthenticatedRequest,
    @Param('saleId', ParseUUIDPipe) saleId: string,
    @Body() dto: SendSaleReceiptDto,
  ) {
    return this.receipts.send({
      tenantId: request.principal.tenant.id,
      branchId: request.principal.context.branch!.id,
      saleId,
      userId: request.principal.user.id,
      correlationId: request.requestId!,
      recipient: dto.email,
    });
  }
}
