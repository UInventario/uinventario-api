import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { SessionGuard } from '../auth/session/session.guard';
import type { AuthenticatedRequest } from '../auth/session/session.types';
import { CreateInventoryTransferDto } from './dto/create-inventory-transfer.dto';
import { InventoryAccessGuard } from './inventory-access.guard';
import { InventoryTransferService } from './inventory-transfer.service';

@Controller('inventory/transfers')
@UseGuards(SessionGuard, InventoryAccessGuard)
export class InventoryTransferController {
  constructor(
    private readonly transfers: InventoryTransferService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list(@Req() request: AuthenticatedRequest) {
    return this.transfers.list(request.principal.tenant.id);
  }

  @Get(':transferId')
  get(
    @Req() request: AuthenticatedRequest,
    @Param('transferId', new ParseUUIDPipe()) transferId: string,
  ) {
    return this.transfers.get(request.principal.tenant.id, transferId);
  }

  @Post()
  async create(
    @Req() request: AuthenticatedRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CreateInventoryTransferDto,
  ) {
    const result = await this.transfers.create({
      tenantId: request.principal.tenant.id,
      originWarehouseId: request.principal.context.warehouse!.id,
      userId: request.principal.user.id,
      idempotencyKey,
      dto,
    });
    await this.record(
      request,
      'INVENTORY_TRANSFER_CREATED',
      result.data.id,
      true,
    );
    return result;
  }

  @Post(':transferId/dispatch')
  @HttpCode(200)
  async dispatch(
    @Req() request: AuthenticatedRequest,
    @Param('transferId', new ParseUUIDPipe()) transferId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    const result = await this.transfers.dispatch({
      tenantId: request.principal.tenant.id,
      transferId,
      userId: request.principal.user.id,
      idempotencyKey,
    });
    await this.record(
      request,
      'INVENTORY_TRANSFER_DISPATCHED',
      result.data.id,
      true,
    );
    return result;
  }

  @Post(':transferId/cancel')
  @HttpCode(200)
  async cancel(
    @Req() request: AuthenticatedRequest,
    @Param('transferId', new ParseUUIDPipe()) transferId: string,
  ) {
    const result = await this.transfers.cancel(
      request.principal.tenant.id,
      transferId,
      request.principal.user.id,
    );
    await this.record(request, 'INVENTORY_TRANSFER_CANCELLED', result.data.id);
    return result;
  }

  private async record(
    request: AuthenticatedRequest,
    action: string,
    entityId: string,
    deduplicate = false,
  ): Promise<void> {
    await this.audit.record({
      tenantId: request.principal.tenant.id,
      actorUserId: request.principal.user.id,
      action,
      entityType: 'INVENTORY_TRANSFER',
      entityId,
      correlationId: request.requestId!,
      deduplicate,
    });
  }
}
