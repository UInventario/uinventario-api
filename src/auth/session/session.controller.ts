import {
  Body,
  Controller,
  Delete,
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
    this.setSessionCookie(response, result.token, result.expiresAt);
    return result.response;
  }

  @Post('refresh')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async refresh(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.sessions.refresh(
      request.principal,
      request.sessionToken,
    );
    this.setSessionCookie(response, result.token, result.expiresAt);
    return result.response;
  }

  @Get('current')
  @UseGuards(SessionGuard)
  current(@Req() request: AuthenticatedRequest) {
    return this.sessions.toResponse(
      request.principal,
      request.principal.expiresAt,
    );
  }

  @Delete('current')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.sessions.logout(request.principal.sessionId);
    response.clearCookie(this.config.cookieName, this.cookieOptions());
  }

  private setSessionCookie(
    response: Response,
    token: string,
    expiresAt: Date,
  ): void {
    response.cookie(this.config.cookieName, token, {
      ...this.cookieOptions(),
      expires: expiresAt,
      maxAge: this.config.ttlMilliseconds,
    });
  }

  private cookieOptions() {
    return {
      httpOnly: true,
      secure: this.config.secureCookie,
      sameSite: 'lax' as const,
      path: '/',
    };
  }
}
