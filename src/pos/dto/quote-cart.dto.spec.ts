import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { QuoteCartLineDto } from './quote-cart.dto';

describe('QuoteCartLineDto', () => {
  const validLine = {
    productId: '7efc799b-2086-4cb6-808d-bfa682543757',
    quantity: '1',
  };

  it('normalizes safe whitespace in a sale line note', async () => {
    const dto = plainToInstance(QuoteCartLineDto, {
      ...validLine,
      note: '  Entregar\n  en mostrador  ',
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto.note).toBe('Entregar en mostrador');
  });

  it('rejects control characters and oversized sale line notes', async () => {
    const unsafe = plainToInstance(QuoteCartLineDto, {
      ...validLine,
      note: 'Visible\u0000oculto',
    });
    const oversized = plainToInstance(QuoteCartLineDto, {
      ...validLine,
      note: 'a'.repeat(241),
    });

    expect(await validate(unsafe)).not.toHaveLength(0);
    expect(await validate(oversized)).not.toHaveLength(0);
  });
});
