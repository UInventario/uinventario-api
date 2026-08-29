import { Controller, Headers, HttpCode, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { ResendWebhookService } from './resend-webhook.service';

@Controller('integrations/webhooks/resend')
export class ResendWebhookController {
  constructor(private readonly webhooks: ResendWebhookService) {}

  @Post()
  @HttpCode(200)
  receive(
    @Req() request: RawBodyRequest<Request>,
    @Headers('svix-id') id: string | undefined,
    @Headers('svix-timestamp') timestamp: string | undefined,
    @Headers('svix-signature') signature: string | undefined,
  ) {
    return this.webhooks.receive({
      payload: request.rawBody,
      id,
      timestamp,
      signature,
    });
  }
}
