import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { sessionConfig } from '../../config/session.config';
import { CreateSessionDto } from './dto/create-session.dto';
import { SessionGuard } from './session.guard';
import { SessionService } from './session.service';
import type { AuthenticatedRequest } from './session.types';

@Controller('auth/sessions')
export class SessionController {
  constructor(
    private readonly sessions: SessionService,
    @Inject(sessionConfig.KEY)
    private readonly config: ConfigType<typeof sessionConfig>,
  ) {}

  @Post()
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async login(
    @Body() dto: CreateSessionDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.sessions.login(dto);
    response.cookie(this.config.cookieName, result.token, {
      httpOnly: true,
      secure: this.config.secureCookie,
      sameSite: 'lax',
      path: '/',
      expires: result.expiresAt,
      maxAge: this.config.ttlMilliseconds,
    });
    return result.response;
  }

  @Get('current')
  @UseGuards(SessionGuard)
  current(@Req() request: AuthenticatedRequest) {
    return this.sessions.toResponse(request.principal);
  }
}
