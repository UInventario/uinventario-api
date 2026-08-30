import {
  Body,
  Controller,
  Delete,
  Get,
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
import { CommerceService } from './commerce.service';
import { CreateCommerceCredentialDto } from './dto/create-commerce-credential.dto';

@Controller('integrations/commerce')
@UseGuards(SessionGuard, PermissionGuard)
@RequirePermissions('TENANT_MANAGE')
export class CommerceAdminController {
  constructor(private readonly commerce: CommerceService) {}

  @Get('credentials')
  credentials(@Req() request: AuthenticatedRequest) {
    return this.commerce.credentials(request.principal.tenant.id);
  }

  @Get('openapi')
  openapi() {
    return this.commerce.openapi();
  }

  @Post('credentials')
  createCredential(
    @Req() request: AuthenticatedRequest,
    @Body() dto: CreateCommerceCredentialDto,
  ) {
    return this.commerce.createCredential({
      tenantId: request.principal.tenant.id,
      userId: request.principal.user.id,
      correlationId: request.requestId!,
      dto,
    });
  }

  @Delete('credentials/:credentialId')
  revokeCredential(
    @Req() request: AuthenticatedRequest,
    @Param('credentialId', ParseUUIDPipe) credentialId: string,
  ) {
    return this.commerce.revokeCredential({
      tenantId: request.principal.tenant.id,
      userId: request.principal.user.id,
      credentialId,
      correlationId: request.requestId!,
    });
  }

  @Post('credentials/:credentialId/rotate')
  rotateCredential(
    @Req() request: AuthenticatedRequest,
    @Param('credentialId', ParseUUIDPipe) credentialId: string,
  ) {
    return this.commerce.rotateCredential({
      tenantId: request.principal.tenant.id,
      userId: request.principal.user.id,
      credentialId,
      correlationId: request.requestId!,
    });
  }

  @Get('webhook-deliveries')
  deliveries(@Req() request: AuthenticatedRequest) {
    return this.commerce.deliveries(request.principal.tenant.id);
  }

  @Post('webhook-deliveries/:deliveryId/replay')
  replayDelivery(
    @Req() request: AuthenticatedRequest,
    @Param('deliveryId', ParseUUIDPipe) deliveryId: string,
  ) {
    return this.commerce.replayDelivery({
      tenantId: request.principal.tenant.id,
      userId: request.principal.user.id,
      deliveryId,
      correlationId: request.requestId!,
    });
  }
}
