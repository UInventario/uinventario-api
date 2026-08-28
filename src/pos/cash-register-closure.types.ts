export interface CashRegisterClosureData {
  id: string;
  status: 'CLOSED';
  branch: { id: string; name: string };
  cashRegister: { id: string; name: string; code: string };
  openedBy: { id: string; email: string };
  closedBy: { id: string; email: string };
  currency: string;
  openingAmount: string;
  salesCount: number;
  cashSales: string;
  movementsCount: number;
  movementsNet: string;
  expectedCash: string;
  countedCash: string;
  difference: string;
  differenceReason: string | null;
  denominations: Array<{ denomination: string; quantity: number }>;
  openedAt: string;
  closedAt: string;
}
