import type { CustomerCreditPaymentMethod } from './dto/create-customer-credit-payment.dto';

export interface CustomerCreditPaymentData {
  id: string;
  receiptNumber: string;
  currency: string;
  amount: string;
  method: CustomerCreditPaymentMethod;
  status: 'COMPLETED' | 'REVERSED';
  reference: string | null;
  provider: string;
  providerReference: string | null;
  responsible: { id: string; email: string };
  context: {
    branch: { id: string; name: string };
    cashRegister: { id: string; name: string; code: string };
  };
  allocations: Array<{
    accountId: string;
    installmentId: string;
    installmentNumber: number;
    amount: string;
  }>;
  reversal: {
    reason: string;
    user: { id: string; email: string };
    providerReference: string | null;
    reversedAt: string;
  } | null;
  createdAt: string;
}
