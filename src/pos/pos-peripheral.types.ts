export type PosPeripheralAction = 'PRINT_RECEIPT' | 'OPEN_DRAWER';
export type PosPeripheralTrigger = 'MANUAL' | 'CASH_SALE_COMPLETED';

export interface PosPeripheralProfileData {
  id: string;
  cashRegister: { id: string; name: string; code: string };
  deviceId: string;
  label: string;
  adapter: 'SIMULATOR';
  printerEnabled: boolean;
  drawerEnabled: boolean;
  autoOpenCashSale: boolean;
  updatedAt: string;
}

export interface PosPeripheralOperationData {
  id: string;
  action: PosPeripheralAction;
  trigger: PosPeripheralTrigger;
  status: 'COMPLETED' | 'FAILED';
  attemptCount: number;
  errorCode: string | null;
  saleId: string | null;
  deviceId: string;
  createdAt: string;
  completedAt: string | null;
}
