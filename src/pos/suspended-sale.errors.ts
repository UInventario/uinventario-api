import type { SuspendedSaleStatus } from './suspended-sale.types';

export class SuspendedSaleStateError extends Error {
  constructor(readonly status: SuspendedSaleStatus) {
    super('SUSPENDED_SALE_NOT_ACTIVE');
  }
}
