import { registerAs } from '@nestjs/config';
import type { PaymentMethod } from '../pos/dto/create-sale.dto';

export const posConfig = registerAs('pos', () => {
  const configured =
    process.env.POS_TAX_RATES ?? 'MX=0.1600,CL=0.1900,DEFAULT=0.0000';
  const nonCashProvider =
    process.env.POS_NONCASH_PROVIDER ??
    (process.env.NODE_ENV === 'production' ? 'DISABLED' : 'SIMULATOR');
  const configuredMethods = (
    process.env.POS_PAYMENT_METHODS ??
    (nonCashProvider === 'SIMULATOR' ? 'CASH,CARD,TRANSFER,VOUCHER' : 'CASH')
  )
    .split(',')
    .map((method) => method.trim())
    .filter((method): method is PaymentMethod =>
      ['CASH', 'CARD', 'TRANSFER', 'VOUCHER'].includes(method),
    );
  return {
    taxRates: Object.fromEntries(
      configured.split(',').map((entry) => {
        const [country, rate] = entry.split('=');
        return [country, rate];
      }),
    ),
    nonCashProvider,
    paymentMethods: [...new Set<PaymentMethod>(['CASH', ...configuredMethods])],
  };
});
