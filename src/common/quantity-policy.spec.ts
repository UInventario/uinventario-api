import { BadRequestException } from '@nestjs/common';
import {
  assertProductQuantityPolicy,
  normalizeProductQuantity,
  quantityFromUnits,
  quantityToUnits,
} from './quantity-policy';

describe('product quantity policy', () => {
  const policy = {
    baseUnit: 'KILOGRAM' as const,
    precision: 2,
    rounding: 'HALF_UP' as const,
    minimumQuantity: '0.250',
  };

  it('converts decimal strings without binary floating point', () => {
    expect(quantityToUnits('12.345')).toBe(12345n);
    expect(quantityToUnits('-0.125')).toBe(-125n);
    expect(quantityFromUnits(12345n)).toBe('12.345');
    expect(quantityFromUnits(-125n)).toBe('-0.125');
  });

  it.each([
    ['HALF_UP', '1.235', '1.240'],
    ['DOWN', '1.239', '1.230'],
    ['UP', '1.231', '1.240'],
  ] as const)(
    'applies %s rounding at the configured precision',
    (rounding, input, expected) => {
      expect(normalizeProductQuantity(input, { ...policy, rounding })).toBe(
        expected,
      );
    },
  );

  it('rounds negative adjustments symmetrically', () => {
    expect(
      normalizeProductQuantity('-1.235', policy, { allowNegative: true }),
    ).toBe('-1.240');
  });

  it('rejects quantities below the configured minimum', () => {
    expect(() => normalizeProductQuantity('0.244', policy)).toThrow(
      BadRequestException,
    );
  });

  it('allows zero when a stock count explicitly opts out of the operation minimum', () => {
    expect(
      normalizeProductQuantity('0', policy, { enforceMinimum: false }),
    ).toBe('0.000');
  });

  it('keeps serial-tracked products on whole units', () => {
    expect(() =>
      assertProductQuantityPolicy(
        { ...policy, baseUnit: 'UNIT', minimumQuantity: '1.000' },
        true,
      ),
    ).toThrow(BadRequestException);
    expect(() =>
      assertProductQuantityPolicy(
        {
          baseUnit: 'UNIT',
          precision: 0,
          rounding: 'HALF_UP',
          minimumQuantity: '1.000',
        },
        true,
      ),
    ).not.toThrow();
  });
});
