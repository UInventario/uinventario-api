export type WhatsappTemplateKey =
  | 'WHATSAPP_SALE_RECEIPT'
  | 'WHATSAPP_ORDER_STATUS'
  | 'WHATSAPP_OPERATIONAL_NOTICE';

export type WhatsappMessageStatus =
  | 'PENDING'
  | 'SENT'
  | 'DELIVERED'
  | 'READ'
  | 'REJECTED'
  | 'FAILED'
  | 'TIMED_OUT';

export interface WhatsappConsentData {
  customerId: string;
  customerName: string;
  phoneMasked: string | null;
  status: 'OPTED_IN' | 'OPTED_OUT';
  changedAt: string;
}

export interface WhatsappMessageData {
  id: string;
  customer: { id: string; name: string };
  template: { key: WhatsappTemplateKey; version: '1' };
  reference: string | null;
  recipientMasked: string;
  provider: 'SIMULATOR';
  providerReference: string | null;
  status: WhatsappMessageStatus;
  errorCode: string | null;
  lastEventAt: string | null;
  createdAt: string;
  updatedAt: string;
}
