export interface LoyaltyRuleData {
  id: string;
  version: number;
  active: boolean;
  earnAmount: string;
  earnPoints: number;
  redeemPoints: number;
  redeemAmount: string;
  expirationDays: number | null;
  createdAt: string;
}

export interface LoyaltyQuoteData {
  rule: LoyaltyRuleData;
  balanceBefore: number;
  pointsRedeemed: number;
  redemptionValue: string;
  pointsEarned: number;
  balanceAfter: number;
}

export interface LoyaltyStatementData {
  customer: { id: string; name: string };
  rule: LoyaltyRuleData | null;
  balance: number;
  entries: Array<{
    id: string;
    type:
      | 'EARN'
      | 'REDEEM'
      | 'EXPIRE'
      | 'VOID_EARN_REVERSAL'
      | 'VOID_REDEEM_RESTORE'
      | 'RETURN_EARN_REVERSAL'
      | 'RETURN_REDEEM_RESTORE';
    points: number;
    monetaryValue: string;
    sale: { id: string; receiptNumber: string } | null;
    saleReturnId: string | null;
    expiresAt: string | null;
    createdAt: string;
  }>;
}

export class LoyaltyInsufficientBalanceError extends Error {
  constructor(
    readonly available: number,
    readonly requested: number,
  ) {
    super('LOYALTY_INSUFFICIENT_BALANCE');
  }
}

export class LoyaltyRuleChangedError extends Error {
  constructor() {
    super('LOYALTY_RULE_CHANGED');
  }
}
