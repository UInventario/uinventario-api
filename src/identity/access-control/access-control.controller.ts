import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { PermissionGuard } from '../../auth/authorization/permission.guard';
import { RequirePermissions } from '../../auth/authorization/require-permissions.decorator';
import { SessionGuard } from '../../auth/session/session.guard';
import type { AuthenticatedRequest } from '../../auth/session/session.types';
import { AuditService } from '../../audit/audit.service';
import { AccessControlService } from './access-control.service';
import { CreateAccessRoleDto } from './dto/create-access-role.dto';
import { CreateAccessUserDto } from './dto/create-access-user.dto';
import { UpdateUserAccessDto } from './dto/update-user-access.dto';

@Controller('access')
@UseGuards(SessionGuard, PermissionGuard)
@RequirePermissions('ACCESS_MANAGE')
export class AccessControlController {
  constructor(
    private readonly access: AccessControlService,
    private readonly audit: AuditService,
  ) {}

  @Get('roles')
  listRoles(@Req() request: AuthenticatedRequest) {
    return this.access.listRoles(request.principal.tenant.id);
  }

  @Post('roles')
  async createRole(
    @Req() request: AuthenticatedRequest,
    @Body() dto: CreateAccessRoleDto,
  ) {
    const result = await this.access.createRole(
      request.principal.tenant.id,
      dto,
    );
    await this.record(request, 'ACCESS_ROLE_CREATED', 'ROLE', result.data.id);
    return result;
  }

  @Get('users')
  listUsers(@Req() request: AuthenticatedRequest) {
    return this.access.listUsers(
      request.principal.tenant.id,
      request.principal.user.id,
    );
  }

  @Post('users')
  async createUser(
    @Req() request: AuthenticatedRequest,
    @Body() dto: CreateAccessUserDto,
  ) {
    const result = await this.access.createUser(
      request.principal.tenant.id,
      request.principal.user.id,
      dto,
    );
    await this.record(request, 'ACCESS_USER_CREATED', 'USER', result.data.id);
    return result;
  }

  @Patch('users/:userId')
  async updateUser(
    @Req() request: AuthenticatedRequest,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() dto: UpdateUserAccessDto,
  ) {
    const result = await this.access.updateUser(
      request.principal.tenant.id,
      request.principal.user.id,
      userId,
      dto,
    );
    await this.record(request, 'ACCESS_USER_UPDATED', 'USER', result.data.id);
    return result;
  }

  private record(
    request: AuthenticatedRequest,
    action: string,
    entityType: string,
    entityId: string,
  ) {
    return this.audit.record({
      tenantId: request.principal.tenant.id,
      actorUserId: request.principal.user.id,
      action,
      entityType,
      entityId,
      correlationId: request.requestId!,
    });
  }
}
