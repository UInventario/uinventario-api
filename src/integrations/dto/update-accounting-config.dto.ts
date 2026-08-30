import { Matches } from 'class-validator';

const ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,63}$/;

export class UpdateAccountingConfigDto {
  @Matches(ACCOUNT)
  paymentClearingAccount!: string;

  @Matches(ACCOUNT)
  salesRevenueAccount!: string;

  @Matches(ACCOUNT)
  salesReturnsAccount!: string;

  @Matches(ACCOUNT)
  taxPayableAccount!: string;

  @Matches(ACCOUNT)
  inventoryAssetAccount!: string;

  @Matches(ACCOUNT)
  costOfGoodsSoldAccount!: string;

  @Matches(ACCOUNT)
  cashAccount!: string;

  @Matches(ACCOUNT)
  cashClearingAccount!: string;
}
