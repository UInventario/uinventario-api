export const PRICE_CHANNELS = ['POS', 'WEB', 'MOBILE', 'DESKTOP'] as const;
export type PriceChannel = (typeof PRICE_CHANNELS)[number];

export interface PriceListData {
  id: string;
  name: string;
  currency: string;
  scope: {
    branch: { id: string; name: string } | null;
    customer: { id: string; name: string } | null;
    channel: PriceChannel | null;
  };
  priority: number;
  validFrom: string;
  validTo: string | null;
  active: boolean;
  version: number;
  items: Array<{
    id: string;
    product: { id: string; name: string; sku: string };
    price: string;
  }>;
  createdAt: string;
  updatedAt: string;
}

export interface ResolvedPrice {
  price: string;
  source: 'PRICE_LIST';
  priceList: { id: string; name: string };
}
