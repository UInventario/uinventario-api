import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
} from '@nestjs/common';
import { CreateRegistrationDto } from './dto/create-registration.dto';
import { RegistrationService } from './registration.service';

@Controller('auth/registrations')
export class RegistrationController {
  constructor(private readonly registration: RegistrationService) {}

  @Post()
  @HttpCode(201)
  register(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CreateRegistrationDto,
  ) {
    if (!idempotencyKey || !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
      throw new BadRequestException({
        code: 'INVALID_IDEMPOTENCY_KEY',
        message: 'La solicitud requiere una clave de idempotencia válida.',
      });
    }

    return this.registration.register(idempotencyKey, dto);
  }
}
