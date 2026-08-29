import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { PermissionGuard } from '../auth/authorization/permission.guard';
import { RequirePermissions } from '../auth/authorization/require-permissions.decorator';
import { SessionGuard } from '../auth/session/session.guard';
import type { AuthenticatedRequest } from '../auth/session/session.types';
import { AuditService } from '../audit/audit.service';
import { CustomerService } from './customer.service';
import { ListCustomersDto } from './dto/list-customers.dto';
import { ListCustomerHistoryDto } from './dto/list-customer-history.dto';
import { SaveCustomerDto, UpdateCustomerDto } from './dto/save-customer.dto';
import { ConfigureCustomerCreditDto } from './dto/configure-customer-credit.dto';

@Controller('customers')
@UseGuards(SessionGuard, PermissionGuard)
@RequirePermissions('SALES_MANAGE')
export class CustomerController {
  constructor(
    private readonly customers: CustomerService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list(@Req() request: AuthenticatedRequest, @Query() query: ListCustomersDto) {
    return this.customers.list(request.principal.tenant.id, query);
  }

  @Get(':id')
  get(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.customers.get(request.principal.tenant.id, id);
  }

  @Get(':id/history')
  history(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListCustomerHistoryDto,
  ) {
    return this.customers.history(
      request.principal.tenant.id,
      request.principal.context.branch!.id,
      id,
      query,
    );
  }

  @Post()
  async create(
    @Req() request: AuthenticatedRequest,
    @Body() dto: SaveCustomerDto,
  ) {
    const result = await this.customers.create(
      request.principal.tenant.id,
      dto,
    );
    await this.audit.record({
      tenantId: request.principal.tenant.id,
      actorUserId: request.principal.user.id,
      action: 'CUSTOMER_CREATED',
      entityType: 'CUSTOMER',
      entityId: result.data.id,
      correlationId: request.requestId!,
      after: {
        active: result.data.active,
        dataProcessingConsent: result.data.dataProcessingConsent,
        hasIdentifier: result.data.identifier !== null,
        hasEmail: result.data.email !== null,
        hasPhone: result.data.phone !== null,
      },
    });
    return result;
  }

  @Patch(':id')
  async update(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCustomerDto,
  ) {
    const before = await this.customers.get(request.principal.tenant.id, id);
    const result = await this.customers.update(
      request.principal.tenant.id,
      id,
      dto,
    );
    await this.audit.record({
      tenantId: request.principal.tenant.id,
      actorUserId: request.principal.user.id,
      action: 'CUSTOMER_UPDATED',
      entityType: 'CUSTOMER',
      entityId: id,
      correlationId: request.requestId!,
      before: {
        active: before.data.active,
        dataProcessingConsent: before.data.dataProcessingConsent,
      },
      after: {
        active: result.data.active,
        dataProcessingConsent: result.data.dataProcessingConsent,
      },
    });
    return result;
  }

  @Patch(':id/credit')
  @RequirePermissions('SALES_MANAGE', 'SALES_CREDIT')
  async configureCredit(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfigureCustomerCreditDto,
  ) {
    const before = await this.customers.get(request.principal.tenant.id, id);
    const result = await this.customers.configureCredit(
      request.principal.tenant.id,
      id,
      request.principal.user.id,
      dto,
    );
    await this.audit.record({
      tenantId: request.principal.tenant.id,
      actorUserId: request.principal.user.id,
      action: 'CUSTOMER_CREDIT_CONFIGURED',
      entityType: 'CUSTOMER',
      entityId: id,
      correlationId: request.requestId!,
      before: { credit: before.data.credit },
      after: { credit: result.data.credit },
    });
    return result;
  }

  @Delete(':id')
  async deactivate(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const before = await this.customers.get(request.principal.tenant.id, id);
    const result = await this.customers.deactivate(
      request.principal.tenant.id,
      id,
    );
    await this.audit.record({
      tenantId: request.principal.tenant.id,
      actorUserId: request.principal.user.id,
      action: 'CUSTOMER_DEACTIVATED',
      entityType: 'CUSTOMER',
      entityId: id,
      correlationId: request.requestId!,
      deduplicate: true,
      before: { active: before.data.active },
      after: { active: false },
    });
    return result;
  }
}
