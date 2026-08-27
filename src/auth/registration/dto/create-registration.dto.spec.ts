import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateRegistrationDto } from './create-registration.dto';

describe('CreateRegistrationDto', () => {
  it('normalizes a valid email and organization', async () => {
    const dto = plainToInstance(CreateRegistrationDto, {
      organizationName: '  Tienda Central  ',
      email: '  Admin@Example.com ',
      password: 'Correcta-2026!',
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto.organizationName).toBe('Tienda Central');
    expect(dto.email).toBe('admin@example.com');
  });

  it.each([
    'corta',
    'sin-mayuscula-2026!',
    'SIN-MINUSCULA-2026!',
    'SinNumeroEspecial!',
    'SinCaracterEspecial2026',
  ])('rejects the weak password %s', async (password) => {
    const dto = plainToInstance(CreateRegistrationDto, {
      organizationName: 'Tienda Central',
      email: 'admin@example.com',
      password,
    });

    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'password')).toBe(true);
  });
});
