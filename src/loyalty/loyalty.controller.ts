import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PermissionGuard } from '../auth/authorization/permission.guard';
import { RequirePermissions } from '../auth/authorization/require-permissions.decorator';
import { SessionGuard } from '../auth/session/session.guard';
import type { AuthenticatedRequest } from '../auth/session/session.types';
import { SaveLoyaltyRuleDto } from './dto/save-loyalty-rule.dto';
import { LoyaltyService } from './loyalty.service';

@Controller('loyalty')
@UseGuards(SessionGuard, PermissionGuard)
@RequirePermissions('SALES_MANAGE')
export class LoyaltyController {
  constructor(
    private readonly loyalty: LoyaltyService,
    private readonly audit: AuditService,
  ) {}

  @Get('rules/current')
  currentRule(@Req() request: AuthenticatedRequest) {
    return this.loyalty.currentRule(request.principal.tenant.id);
  }

  @Put('rules/current')
  async createRuleVersion(
    @Req() request: AuthenticatedRequest,
    @Body() dto: SaveLoyaltyRuleDto,
  ) {
    const result = await this.loyalty.createRuleVersion(
      request.principal.tenant.id,
      request.principal.user.id,
      dto,
    );
    await this.audit.record({
      tenantId: request.principal.tenant.id,
      actorUserId: request.principal.user.id,
      action: 'LOYALTY_RULE_VERSION_CREATED',
      entityType: 'LOYALTY_RULE',
      entityId: result.data.id,
      correlationId: request.requestId!,
      after: {
        version: result.data.version,
        active: result.data.active,
        expirationDays: result.data.expirationDays,
      },
    });
    return result;
  }

  @Get('customers/:customerId')
  statement(
    @Req() request: AuthenticatedRequest,
    @Param('customerId', ParseUUIDPipe) customerId: string,
  ) {
    return this.loyalty.statement(
      request.principal.tenant.id,
      customerId,
      request.principal.user.id,
    );
  }
}
