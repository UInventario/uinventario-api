import type { PriceChannel } from '../pricing/price-list.types';

export const PROMOTION_TYPES = [
  'BUY_X_GET_Y',
  'SECOND_UNIT_PERCENT',
  'BUNDLE_FIXED',
  'QUANTITY_PERCENT',
] as const;
export type PromotionType = (typeof PROMOTION_TYPES)[number];

export interface PromotionData {
  id: string;
  name: string;
  type: PromotionType;
  scope: {
    branch: { id: string; name: string } | null;
    customer: { id: string; name: string } | null;
    channel: PriceChannel | null;
  };
  priority: number;
  stackable: boolean;
  validFrom: string;
  validTo: string | null;
  active: boolean;
  discountPercent: string | null;
  fixedPrice: string | null;
  buyQuantity: string | null;
  rewardQuantity: string | null;
  version: number;
  products: Array<{
    product: { id: string; name: string; sku: string };
    quantity: string;
  }>;
  tiers: Array<{ minimumQuantity: string; discountPercent: string }>;
  createdAt: string;
  updatedAt: string;
}

export interface AppliedPromotion {
  promotion: {
    id: string;
    name: string;
    type: PromotionType;
    priority: number;
  };
  amount: string;
  explanation: string;
  ruleSnapshot: Record<string, unknown>;
}
