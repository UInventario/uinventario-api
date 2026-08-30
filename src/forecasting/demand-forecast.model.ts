import type {
  DemandForecastItem,
  DemandForecastProductInput,
} from './demand-forecast.types';

export const FORECAST_MINIMUM = {
  coverageDays: 42,
  daysWithDemand: 12,
  totalDemand: 20,
} as const;

const HISTORY_DAYS = 56;
const BACKTEST_DAYS = 14;

export function forecastDemand(input: {
  asOfDate: string;
  horizonDays: number;
  product: DemandForecastProductInput;
}): DemandForecastItem {
  const historyDates = dateRange(input.asOfDate, -HISTORY_DAYS, -1);
  const byDate = new Map(
    input.product.observations.map((row) => [row.date, row.quantity]),
  );
  const values = historyDates.map((date) => Math.max(0, byDate.get(date) ?? 0));
  const firstDemand = values.findIndex((value) => value > 0);
  const coverageDays = firstDemand < 0 ? 0 : HISTORY_DAYS - firstDemand;
  const daysWithDemand = values.filter((value) => value > 0).length;
  const totalDemand = round(values.reduce((sum, value) => sum + value, 0));
  const sufficient =
    coverageDays >= FORECAST_MINIMUM.coverageDays &&
    daysWithDemand >= FORECAST_MINIMUM.daysWithDemand &&
    totalDemand >= FORECAST_MINIMUM.totalDemand;

  const backtest = calculateBacktest(historyDates, values);
  const drift = calculateDrift(values);
  const quality = {
    coverageDays,
    daysWithDemand,
    totalDemand,
    minimum: { ...FORECAST_MINIMUM },
    backtest,
    drift,
  };
  if (!sufficient) {
    return {
      product: input.product.product,
      status: 'INSUFFICIENT',
      quality,
      forecast: null,
    };
  }

  const weekdayMeans = meansByWeekday(historyDates, values);
  const futureDates = dateRange(input.asOfDate, 0, input.horizonDays - 1);
  const expectedDemand = round(
    futureDates.reduce((sum, date) => sum + weekdayMeans[weekday(date)], 0),
  );
  const mae = backtest.meanAbsoluteError ?? mean(values);
  const uncertainty = 1.282 * mae * Math.sqrt(input.horizonDays);
  const lower = round(Math.max(0, expectedDemand - uncertainty));
  const upper = round(expectedDemand + uncertainty);
  return {
    product: input.product.product,
    status: 'SUFFICIENT',
    quality,
    forecast: {
      horizonDays: input.horizonDays,
      expectedDemand,
      interval: { confidence: 'APPROXIMATE_80', lower, upper },
      availableQuantity: round(input.product.availableQuantity),
      suggestedReorderQuantity: round(
        Math.max(0, upper - input.product.availableQuantity),
      ),
    },
  };
}

function calculateBacktest(dates: string[], values: number[]) {
  const trainDates = dates.slice(0, -BACKTEST_DAYS);
  const trainValues = values.slice(0, -BACKTEST_DAYS);
  const actual = values.slice(-BACKTEST_DAYS);
  if (trainValues.length === 0) return { samples: 0, meanAbsoluteError: null };
  const means = meansByWeekday(trainDates, trainValues);
  const predicted = dates
    .slice(-BACKTEST_DAYS)
    .map((date) => means[weekday(date)]);
  return {
    samples: actual.length,
    meanAbsoluteError: round(
      actual.reduce(
        (sum, value, index) => sum + Math.abs(value - predicted[index]),
        0,
      ) / actual.length,
    ),
  };
}

function calculateDrift(values: number[]) {
  const previous = mean(values.slice(-28, -14));
  const recent = mean(values.slice(-14));
  if (previous === 0) {
    return {
      ratio: recent === 0 ? 1 : null,
      status: recent === 0 ? ('STABLE' as const) : ('UNKNOWN' as const),
    };
  }
  const ratio = round(recent / previous);
  return {
    ratio,
    status:
      ratio < 0.5 || ratio > 1.5 ? ('WARNING' as const) : ('STABLE' as const),
  };
}

function meansByWeekday(dates: string[], values: number[]): number[] {
  const sums = Array<number>(7).fill(0);
  const counts = Array<number>(7).fill(0);
  dates.forEach((date, index) => {
    const day = weekday(date);
    sums[day] += values[index] ?? 0;
    counts[day] += 1;
  });
  const overall = mean(values);
  return sums.map((sum, day) => (counts[day] ? sum / counts[day] : overall));
}

function dateRange(anchor: string, from: number, to: number): string[] {
  const anchorDate = new Date(`${anchor}T00:00:00.000Z`);
  return Array.from({ length: to - from + 1 }, (_, index) => {
    const date = new Date(anchorDate);
    date.setUTCDate(date.getUTCDate() + from + index);
    return date.toISOString().slice(0, 10);
  });
}

function weekday(date: string): number {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay();
}

function mean(values: number[]): number {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}
