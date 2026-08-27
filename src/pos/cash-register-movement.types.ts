export type CashRegisterMovementType = 'INCOME' | 'WITHDRAWAL' | 'REVERSAL';

export interface CashRegisterMovementData {
  id: string;
  type: CashRegisterMovementType;
  amount: string;
  reason: string;
  responsible: { id: string; email: string };
  reversalOf: {
    id: string;
    type: 'INCOME' | 'WITHDRAWAL';
    reason: string;
  } | null;
  reversed: boolean;
  createdAt: string;
}
