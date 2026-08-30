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
import { AuditService } from '../audit/audit.service';
import { PermissionGuard } from '../auth/authorization/permission.guard';
import { RequirePermissions } from '../auth/authorization/require-permissions.decorator';
import { SessionGuard } from '../auth/session/session.guard';
import type { AuthenticatedRequest } from '../auth/session/session.types';
import { SendWhatsappMessageDto } from './dto/send-whatsapp-message.dto';
import { UpdateWhatsappConsentDto } from './dto/update-whatsapp-consent.dto';
import { WhatsappWebhookDto } from './dto/whatsapp-webhook.dto';
import { WhatsappService } from './whatsapp.service';

@Controller('integrations/whatsapp/v1')
@UseGuards(SessionGuard, PermissionGuard)
@RequirePermissions('TENANT_MANAGE')
export class WhatsappController {
  constructor(
    private readonly whatsapp: WhatsappService,
    private readonly audit: AuditService,
  ) {}

  @Get('contract')
  contract() {
    return this.whatsapp.contract();
  }

  @Get('consents')
  consents(@Req() request: AuthenticatedRequest) {
    return this.whatsapp.consents(request.principal.tenant.id);
  }

  @Put('customers/:customerId/consent')
  async consent(
    @Req() request: AuthenticatedRequest,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() dto: UpdateWhatsappConsentDto,
  ) {
    const result = await this.whatsapp.setConsent({
      tenantId: request.principal.tenant.id,
      customerId,
      userId: request.principal.user.id,
      enabled: dto.enabled,
    });
    await this.record(request, 'WHATSAPP_CONSENT_UPDATED', customerId, {
      status: result.data.status,
    });
    return result;
  }

  @Post('customers/:customerId/messages')
  async send(
    @Req() request: AuthenticatedRequest,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: SendWhatsappMessageDto,
  ) {
    const result = await this.whatsapp.send({
      tenantId: request.principal.tenant.id,
      userId: request.principal.user.id,
      customerId,
      idempotencyKey: idempotencyKey ?? '',
      correlationId: request.requestId!,
      dto,
    });
    await this.record(request, 'WHATSAPP_MESSAGE_SENT', result.data.id, {
      customerId,
      template: result.data.template,
      status: result.data.status,
      provider: result.data.provider,
    });
    return result;
  }

  @Get('messages')
  messages(@Req() request: AuthenticatedRequest) {
    return this.whatsapp.messages(request.principal.tenant.id);
  }

  @Post('webhooks/simulator')
  async webhook(
    @Req() request: AuthenticatedRequest,
    @Headers('x-simulator-webhook-token') token: string | undefined,
    @Body() dto: WhatsappWebhookDto,
  ) {
    const result = await this.whatsapp.webhook({
      tenantId: request.principal.tenant.id,
      token: token ?? '',
      dto,
    });
    await this.record(request, 'WHATSAPP_WEBHOOK_RECEIVED', result.data.id, {
      providerEventId: dto.providerEventId,
      status: dto.status,
      idempotentReplay: result.meta.idempotentReplay,
      ignoredOutOfOrder: result.meta.ignoredOutOfOrder,
    });
    return result;
  }

  private record(
    request: AuthenticatedRequest,
    action: string,
    entityId: string,
    after: Record<string, unknown>,
  ) {
    return this.audit.record({
      tenantId: request.principal.tenant.id,
      actorUserId: request.principal.user.id,
      action,
      entityType: 'WHATSAPP_INTEGRATION',
      entityId,
      correlationId: request.requestId!,
      deduplicate: true,
      after,
    });
  }
}
