import { registerAs } from '@nestjs/config';

export const posConfig = registerAs('pos', () => {
  const configured =
    process.env.POS_TAX_RATES ?? 'MX=0.1600,CL=0.1900,DEFAULT=0.0000';
  return {
    taxRates: Object.fromEntries(
      configured.split(',').map((entry) => {
        const [country, rate] = entry.split('=');
        return [country, rate];
      }),
    ),
  };
});
