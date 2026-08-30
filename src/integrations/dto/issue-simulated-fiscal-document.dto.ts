import { IsIn, Matches } from 'class-validator';
import { FISCAL_DOCUMENT_TYPES } from '../fiscal-contract.types';

export class IssueSimulatedFiscalDocumentDto {
  @IsIn(FISCAL_DOCUMENT_TYPES)
  documentType!: (typeof FISCAL_DOCUMENT_TYPES)[number];

  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,79}$/)
  reference!: string;

  @IsIn(['SUCCESS', 'REJECT', 'TIMEOUT'])
  scenario!: 'SUCCESS' | 'REJECT' | 'TIMEOUT';
}
