import { FORECAST_MINIMUM, forecastDemand } from './demand-forecast.model';

const product = { id: 'product-1', name: 'CafÃ©', sku: 'CAFE-1' };

describe('forecastDemand', () => {
  it('reports insufficient information without inventing a forecast', () => {
    const result = forecastDemand({
      asOfDate: '2026-08-29',
      horizonDays: 14,
      product: {
        product,
        availableQuantity: 5,
        observations: [{ date: '2026-08-28', quantity: 2 }],
      },
    });

    expect(result.status).toBe('INSUFFICIENT');
    expect(result.forecast).toBeNull();
    expect(result.quality.minimum).toEqual(FORECAST_MINIMUM);
    expect(result.quality.coverageDays).toBe(1);
  });

  it('uses weekday seasonality, exposes uncertainty and suggests without creating a purchase', () => {
    const observations = observationsForDays('2026-07-04', 56, (date) =>
      [0, 6].includes(date.getUTCDay()) ? 10 : 2,
    );
    const result = forecastDemand({
      asOfDate: '2026-08-29',
      horizonDays: 7,
      product: { product, availableQuantity: 12, observations },
    });

    expect(result.status).toBe('SUFFICIENT');
    expect(result.forecast).toMatchObject({
      horizonDays: 7,
      expectedDemand: 30,
      availableQuantity: 12,
      suggestedReorderQuantity: 18,
      interval: { confidence: 'APPROXIMATE_80', lower: 30, upper: 30 },
    });
    expect(result.quality.backtest).toEqual({
      samples: 14,
      meanAbsoluteError: 0,
    });
  });

  it('records drift and widens the interval when backtest error rises', () => {
    const observations = observationsForDays('2026-07-04', 56, (_, index) =>
      index < 42 ? 1 : 4,
    );
    const result = forecastDemand({
      asOfDate: '2026-08-29',
      horizonDays: 14,
      product: { product, availableQuantity: 0, observations },
    });

    expect(result.status).toBe('SUFFICIENT');
    expect(result.quality.drift.status).toBe('WARNING');
    expect(result.quality.backtest.meanAbsoluteError).toBe(3);
    expect(result.forecast!.interval.upper).toBeGreaterThan(
      result.forecast!.expectedDemand,
    );
  });
});

function observationsForDays(
  start: string,
  count: number,
  quantity: (date: Date, index: number) => number,
) {
  const first = new Date(`${start}T00:00:00.000Z`);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(first);
    date.setUTCDate(date.getUTCDate() + index);
    return {
      date: date.toISOString().slice(0, 10),
      quantity: quantity(date, index),
    };
  });
}
