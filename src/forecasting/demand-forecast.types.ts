export interface DemandObservation {
  date: string;
  quantity: number;
}

export interface DemandForecastProductInput {
  product: { id: string; name: string; sku: string };
  availableQuantity: number;
  observations: DemandObservation[];
}

export interface DemandForecastItem {
  product: { id: string; name: string; sku: string };
  status: 'SUFFICIENT' | 'INSUFFICIENT';
  quality: {
    coverageDays: number;
    daysWithDemand: number;
    totalDemand: number;
    minimum: {
      coverageDays: number;
      daysWithDemand: number;
      totalDemand: number;
    };
    backtest: { samples: number; meanAbsoluteError: number | null };
    drift: { ratio: number | null; status: 'STABLE' | 'WARNING' | 'UNKNOWN' };
  };
  forecast: null | {
    horizonDays: number;
    expectedDemand: number;
    interval: { confidence: 'APPROXIMATE_80'; lower: number; upper: number };
    availableQuantity: number;
    suggestedReorderQuantity: number;
  };
}

export interface DemandForecastResult {
  id: string;
  branch: { id: string; name: string; timezone: string };
  status: 'READY' | 'INSUFFICIENT';
  asOfDate: string;
  horizonDays: number;
  model: 'WEEKDAY_BASELINE_V1';
  assumptions: string[];
  generatedAt: string;
  items: DemandForecastItem[];
  summary: { sufficient: number; insufficient: number; driftWarnings: number };
}
