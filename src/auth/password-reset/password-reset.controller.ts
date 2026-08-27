import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CompletePasswordResetDto } from './dto/complete-password-reset.dto';
import { RequestPasswordResetDto } from './dto/request-password-reset.dto';
import { ConfiguredPasswordResetDelivery } from './password-reset.delivery';
import { PasswordResetService } from './password-reset.service';

@Controller('auth/password-resets')
export class PasswordResetController {
  constructor(
    private readonly resets: PasswordResetService,
    private readonly localDelivery: ConfiguredPasswordResetDelivery,
  ) {}

  @Post()
  @HttpCode(202)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  request(@Body() dto: RequestPasswordResetDto) {
    return this.resets.request(dto);
  }

  @Post('complete')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  complete(@Body() dto: CompletePasswordResetDto) {
    return this.resets.complete(dto);
  }

  @Get('local-mailbox')
  localMailbox(@Query() dto: RequestPasswordResetDto) {
    return {
      data: this.localDelivery.localMessage(dto.email),
      meta: { apiVersion: '1' as const },
    };
  }
}
