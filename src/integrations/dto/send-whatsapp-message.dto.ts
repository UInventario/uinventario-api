import { IsIn, IsOptional, Matches } from 'class-validator';
import type { WhatsappTemplateKey } from '../whatsapp.types';

export class SendWhatsappMessageDto {
  @IsIn([
    'WHATSAPP_SALE_RECEIPT',
    'WHATSAPP_ORDER_STATUS',
    'WHATSAPP_OPERATIONAL_NOTICE',
  ])
  templateKey!: WhatsappTemplateKey;

  @IsOptional()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,119}$/)
  reference?: string;

  @IsIn(['SUCCESS', 'REJECT', 'TIMEOUT', 'RETRY'])
  scenario!: 'SUCCESS' | 'REJECT' | 'TIMEOUT' | 'RETRY';
}
