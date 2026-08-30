import { IsIn } from 'class-validator';
import { FISCAL_DOCUMENT_TYPES } from '../../integrations/fiscal-contract.types';

export class IssueSaleFiscalDocumentDto {
  @IsIn(FISCAL_DOCUMENT_TYPES)
  documentType!: (typeof FISCAL_DOCUMENT_TYPES)[number];

  @IsIn(['SUCCESS', 'REJECT', 'TIMEOUT'])
  scenario!: 'SUCCESS' | 'REJECT' | 'TIMEOUT';
}
