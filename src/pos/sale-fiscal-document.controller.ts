import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
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
import { IssueSaleFiscalDocumentDto } from './dto/issue-sale-fiscal-document.dto';
import { SaleFiscalCallbackDto } from './dto/sale-fiscal-callback.dto';
import { SendSaleReceiptDto } from './dto/send-sale-receipt.dto';
import { PosAccessGuard } from './pos-access.guard';
import { SaleFiscalDocumentService } from './sale-fiscal-document.service';

@Controller('pos/sales')
@UseGuards(SessionGuard, PosAccessGuard, PermissionGuard)
@RequirePermissions('SALE_REPRINT')
export class SaleFiscalDocumentController {
  constructor(private readonly documents: SaleFiscalDocumentService) {}

  @Get(':saleId/fiscal-document')
  get(
    @Req() request: AuthenticatedRequest,
    @Param('saleId', ParseUUIDPipe) saleId: string,
  ) {
    return this.documents.get(
      request.principal.tenant.id,
      request.principal.context.branch!.id,
      saleId,
    );
  }

  @Post(':saleId/fiscal-document')
  @RequirePermissions('SALES_MANAGE')
  issue(
    @Req() request: AuthenticatedRequest,
    @Param('saleId', ParseUUIDPipe) saleId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: IssueSaleFiscalDocumentDto,
  ) {
    return this.documents.issue({
      ...this.context(request, saleId),
      idempotencyKey: idempotencyKey ?? '',
      dto,
    });
  }

  @Post(':saleId/fiscal-document/queries')
  query(
    @Req() request: AuthenticatedRequest,
    @Param('saleId', ParseUUIDPipe) saleId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return this.documents.query({
      ...this.context(request, saleId),
      idempotencyKey: idempotencyKey ?? '',
    });
  }

  @Post(':saleId/fiscal-document/cancellations')
  @RequirePermissions('SALES_VOID')
  cancel(
    @Req() request: AuthenticatedRequest,
    @Param('saleId', ParseUUIDPipe) saleId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return this.documents.cancel({
      ...this.context(request, saleId),
      idempotencyKey: idempotencyKey ?? '',
    });
  }

  @Post('fiscal-document/callbacks')
  @RequirePermissions('SALES_MANAGE')
  callback(
    @Req() request: AuthenticatedRequest,
    @Body() dto: SaleFiscalCallbackDto,
  ) {
    return this.documents.callback({
      ...this.context(request, dto.saleId),
      eventId: dto.eventId,
      status: dto.status,
    });
  }

  @Get(':saleId/fiscal-document/artifacts/:kind')
  artifact(
    @Req() request: AuthenticatedRequest,
    @Param('saleId', ParseUUIDPipe) saleId: string,
    @Param('kind') kind: 'PDF' | 'XML',
  ) {
    if (!['PDF', 'XML'].includes(kind)) {
      throw new BadRequestException('FISCAL_ARTIFACT_KIND_INVALID');
    }
    return this.documents.artifact(
      request.principal.tenant.id,
      request.principal.context.branch!.id,
      saleId,
      kind,
    );
  }

  @Post(':saleId/fiscal-document/deliveries')
  send(
    @Req() request: AuthenticatedRequest,
    @Param('saleId', ParseUUIDPipe) saleId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: SendSaleReceiptDto,
  ) {
    return this.documents.send({
      ...this.context(request, saleId),
      idempotencyKey: idempotencyKey ?? '',
      recipient: dto.email,
    });
  }

  private context(request: AuthenticatedRequest, saleId: string) {
    return {
      tenantId: request.principal.tenant.id,
      branchId: request.principal.context.branch!.id,
      saleId,
      userId: request.principal.user.id,
      correlationId: request.requestId!,
    };
  }
}
