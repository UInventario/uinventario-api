import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
} from '@nestjs/common';
import { AuditService } from '../../audit/audit.service';
import type { RequestContext } from '../../security/request-context';
import { CreateRegistrationDto } from './dto/create-registration.dto';
import { RegistrationService } from './registration.service';

@Controller('auth/registrations')
export class RegistrationController {
  constructor(
    private readonly registration: RegistrationService,
    private readonly audit: AuditService,
  ) {}

  @Post()
  @HttpCode(201)
  async register(
    @Req() request: RequestContext,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CreateRegistrationDto,
  ) {
    if (!idempotencyKey || !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
      throw new BadRequestException({
        code: 'INVALID_IDEMPOTENCY_KEY',
        message: 'La solicitud requiere una clave de idempotencia válida.',
      });
    }

    const result = await this.registration.register(idempotencyKey, dto);
    await this.audit.record({
      tenantId: result.data.tenant.id,
      actorUserId: result.data.user.id,
      action: 'REGISTRATION_CREATED',
      entityType: 'TENANT',
      entityId: result.data.tenant.id,
      correlationId: request.requestId!,
      deduplicate: true,
    });
    return result;
  }
}
