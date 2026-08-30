import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DemandForecastIdempotencyConflictError } from './demand-forecast.errors';
import { DemandForecastRepository } from './demand-forecast.repository';

@Injectable()
export class DemandForecastService {
  constructor(private readonly forecasts: DemandForecastRepository) {}

  async latest(
    tenantId: string,
    userId: string,
    branchId: string,
    administrator: boolean,
  ) {
    const result = await this.forecasts.latest(
      tenantId,
      userId,
      branchId,
      administrator,
    );
    if (result === null) throw new NotFoundException();
    return { data: result ?? null, meta: { apiVersion: '1' as const } };
  }

  async generate(input: Parameters<DemandForecastRepository['generate']>[0]) {
    if (!input.idempotencyKey || input.idempotencyKey.length > 128) {
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message:
          'Idempotency-Key es obligatorio y debe tener hasta 128 caracteres.',
      });
    }
    try {
      const generated = await this.forecasts.generate(input);
      if (!generated) throw new NotFoundException();
      return {
        data: generated.result,
        meta: { apiVersion: '1' as const, idempotentReplay: generated.replay },
      };
    } catch (error) {
      if (error instanceof DemandForecastIdempotencyConflictError) {
        throw new ConflictException({
          code: 'IDEMPOTENCY_KEY_CONFLICT',
          message: 'La llave ya fue utilizada con una solicitud diferente.',
        });
      }
      throw error;
    }
  }
}
