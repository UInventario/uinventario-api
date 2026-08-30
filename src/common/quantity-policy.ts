import { BadRequestException } from '@nestjs/common';

export const PRODUCT_BASE_UNITS = [
  'UNIT',
  'KILOGRAM',
  'GRAM',
  'LITER',
  'MILLILITER',
  'METER',
  'CENTIMETER',
] as const;
export type ProductBaseUnit = (typeof PRODUCT_BASE_UNITS)[number];

export const QUANTITY_ROUNDING_MODES = ['HALF_UP', 'DOWN', 'UP'] as const;
export type QuantityRoundingMode = (typeof QUANTITY_ROUNDING_MODES)[number];

export interface ProductQuantityPolicy {
  baseUnit: ProductBaseUnit;
  precision: number;
  rounding: QuantityRoundingMode;
  minimumQuantity: string;
}

/** Stable boundary for future scale/scanner adapters; values stay decimal strings. */
export interface QuantityInputAdapter {
  read(input: {
    tenantId: string;
    productId: string;
    expectedUnit: ProductBaseUnit;
  }): Promise<{ value: string; unit: ProductBaseUnit; capturedAt: string }>;
}

const SCALE = 1000n;
const QUANTITY_PATTERN = /^-?(?:0|[1-9]\d{0,11})(?:\.\d{1,3})?$/;

export function quantityToUnits(value: string): bigint {
  if (!QUANTITY_PATTERN.test(value)) {
    throw invalidQuantity(
      'La cantidad debe tener como m\u00e1ximo 3 decimales.',
    );
  }
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ''] = unsigned.split('.');
  const units = BigInt(whole) * SCALE + BigInt(fraction.padEnd(3, '0'));
  return negative ? -units : units;
}

export function quantityFromUnits(units: bigint): string {
  const sign = units < 0n ? '-' : '';
  const absolute = units < 0n ? -units : units;
  return `${sign}${absolute / SCALE}.${String(absolute % SCALE).padStart(3, '0')}`;
}

export function assertProductQuantityPolicy(
  policy: ProductQuantityPolicy,
  trackSerials = false,
): void {
  if (
    !PRODUCT_BASE_UNITS.includes(policy.baseUnit) ||
    !Number.isInteger(policy.precision)
  ) {
    throw invalidPolicy();
  }
  if (policy.precision < 0 || policy.precision > 3) throw invalidPolicy();
  if (!QUANTITY_ROUNDING_MODES.includes(policy.rounding)) throw invalidPolicy();
  const minimum = quantityToUnits(policy.minimumQuantity);
  if (
    minimum <= 0n ||
    roundUnits(minimum, policy.precision, 'DOWN') !== minimum
  ) {
    throw invalidPolicy(
      'La cantidad m\u00ednima debe respetar la precisi\u00f3n configurada.',
    );
  }
  if (
    trackSerials &&
    (policy.baseUnit !== 'UNIT' || policy.precision !== 0 || minimum !== SCALE)
  ) {
    throw invalidPolicy(
      'Los productos con series deben usar unidad, precisi\u00f3n 0 y cantidad m\u00ednima 1.',
    );
  }
}

export function normalizeProductQuantity(
  value: string,
  policy: ProductQuantityPolicy,
  options: { allowNegative?: boolean; enforceMinimum?: boolean } = {},
): string {
  assertProductQuantityPolicy(policy);
  const original = quantityToUnits(value);
  if (!options.allowNegative && original < 0n) {
    throw invalidQuantity('La cantidad no puede ser negativa.');
  }
  const rounded = roundUnits(original, policy.precision, policy.rounding);
  const absolute = rounded < 0n ? -rounded : rounded;
  const minimum = quantityToUnits(policy.minimumQuantity);
  if ((options.enforceMinimum ?? true) && absolute > 0n && absolute < minimum) {
    throw new BadRequestException({
      code: 'PRODUCT_QUANTITY_BELOW_MINIMUM',
      minimumQuantity: quantityFromUnits(minimum),
      message: `La cantidad m\u00ednima para este producto es ${quantityFromUnits(minimum)}.`,
    });
  }
  return quantityFromUnits(rounded);
}

function roundUnits(
  units: bigint,
  precision: number,
  mode: QuantityRoundingMode,
): bigint {
  const quantum = [1000n, 100n, 10n, 1n][precision];
  const sign = units < 0n ? -1n : 1n;
  const absolute = units < 0n ? -units : units;
  const quotient = absolute / quantum;
  const remainder = absolute % quantum;
  const increment =
    remainder === 0n
      ? 0n
      : mode === 'UP' || (mode === 'HALF_UP' && remainder * 2n >= quantum)
        ? 1n
        : 0n;
  return sign * (quotient + increment) * quantum;
}

function invalidPolicy(
  message = 'La pol\u00edtica de cantidades del producto no es v\u00e1lida.',
) {
  return new BadRequestException({
    code: 'INVALID_PRODUCT_QUANTITY_POLICY',
    message,
  });
}

function invalidQuantity(message: string) {
  return new BadRequestException({ code: 'INVALID_PRODUCT_QUANTITY', message });
}
