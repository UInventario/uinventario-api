import {
  Body,
  Controller,
  Header,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuditService } from '../../audit/audit.service';
import type { RequestContext } from '../../security/request-context';
import { CreateSessionDto } from './dto/create-session.dto';
import { SessionGuard } from './session.guard';
import { SessionService } from './session.service';
import type {
  AuthenticatedRequest,
  MobileSessionResponse,
  SessionResponse,
} from './session.types';

@Controller('auth/mobile/sessions')
export class MobileSessionController {
  constructor(
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async login(
    @Req() request: RequestContext,
    @Body() dto: CreateSessionDto,
  ): Promise<MobileSessionResponse> {
    const result = await this.sessions.login(dto);
    await this.audit.record({
      tenantId: result.response.data.tenant.id,
      actorUserId: result.response.data.user.id,
      action: 'AUTH_LOGIN_SUCCEEDED',
      entityType: 'USER',
      entityId: result.response.data.user.id,
      correlationId: request.requestId!,
      after: { client: 'MOBILE' },
    });
    return this.withToken(result.response, result.token);
  }

  @Post('refresh')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @UseGuards(SessionGuard)
  async refresh(
    @Req() request: AuthenticatedRequest,
  ): Promise<MobileSessionResponse> {
    const result = await this.sessions.refresh(
      request.principal,
      request.sessionToken,
    );
    return this.withToken(result.response, result.token);
  }

  private withToken(
    response: SessionResponse,
    token: string,
  ): MobileSessionResponse {
    return {
      ...response,
      auth: {
        tokenType: 'Bearer',
        accessToken: token,
      },
    };
  }
}
