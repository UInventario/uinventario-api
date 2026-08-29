import type {
  PosAppliedDiscount,
  PosCartQuoteResponse,
} from '../pos/pos.types';

export type SalesQuotationStatus =
  'ACTIVE' | 'EXPIRED' | 'CONVERTING' | 'CONVERTED';

export interface SalesQuotationData {
  id: string;
  quotationNumber: string;
  status: SalesQuotationStatus;
  version: number;
  channel: 'POS' | 'WEB' | 'MOBILE' | 'DESKTOP';
  customer: { id: string; name: string; identifier: string | null } | null;
  reservation: { id: string; reservationNumber: string; status: string } | null;
  sale: { id: string; receiptNumber: string } | null;
  context: PosCartQuoteResponse['data']['context'];
  currency: string;
  taxRate: string;
  discount: PosAppliedDiscount | null;
  lines: PosCartQuoteResponse['data']['lines'];
  totals: PosCartQuoteResponse['data']['totals'];
  validUntil: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  convertedAt: string | null;
}

export interface QuotationDifference {
  product: { id: string; name: string; sku: string };
  field: 'UNIT_PRICE' | 'AVAILABLE_STOCK' | 'TOTAL';
  quoted: string;
  current: string;
  blocking: boolean;
}

export interface SalesQuotationPreview {
  quotation: SalesQuotationData;
  recalculated: PosCartQuoteResponse['data'];
  differences: QuotationDifference[];
  canConvert: boolean;
}
