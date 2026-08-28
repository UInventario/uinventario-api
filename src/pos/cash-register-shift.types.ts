export interface CashRegisterShiftData {
  id: string;
  status: 'OPEN';
  branch: { id: string; name: string };
  cashRegister: { id: string; name: string; code: string };
  openedBy: { id: string; email: string };
  openingAmount: string;
  currency: string;
  openedAt: string;
}

export interface CashRegisterShiftResponse {
  data: CashRegisterShiftData;
  meta: { apiVersion: '1'; idempotentReplay: boolean };
}
