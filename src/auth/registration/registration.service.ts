import { ConflictException, Injectable } from '@nestjs/common';
import { argon2id, hash } from 'argon2';
import { createHash } from 'node:crypto';
import { CreateRegistrationDto } from './dto/create-registration.dto';
import { RegistrationConflictError } from './registration.errors';
import { RegistrationRepository } from './registration.repository';
import { RegistrationResponse } from './registration.types';

@Injectable()
export class RegistrationService {
  constructor(private readonly registrations: RegistrationRepository) {}

  async register(
    idempotencyKey: string,
    dto: CreateRegistrationDto,
  ): Promise<RegistrationResponse> {
    const organizationName = dto.organizationName.replace(/\s+/g, ' ').trim();
    const normalizedEmail = dto.email.trim().toLowerCase();
    const requestFingerprint = createHash('sha256')
      .update(`${normalizedEmail}\0${organizationName}`)
      .digest('hex');
    const passwordHash = await hash(dto.password, {
      type: argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });

    try {
      const result = await this.registrations.create({
        idempotencyKey,
        requestFingerprint,
        organizationName,
        email: normalizedEmail,
        normalizedEmail,
        passwordHash,
      });

      return {
        data: { ...result, nextStep: 'LOGIN' },
        meta: { apiVersion: '1' },
      };
    } catch (error) {
      if (error instanceof RegistrationConflictError) {
        throw new ConflictException({
          code: 'REGISTRATION_NOT_AVAILABLE',
          message:
            'No fue posible crear la cuenta con los datos proporcionados.',
        });
      }
      throw error;
    }
  }
}
