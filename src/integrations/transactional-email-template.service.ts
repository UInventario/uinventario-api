import { Injectable } from '@nestjs/common';
import type { SaleReceiptData } from '../pos/sale-receipt.types';
import type { ExternalEmailTemplate } from './external-adapter.types';

@Injectable()
export class TransactionalEmailTemplateService {
  passwordReset(input: { resetUrl: string; expiresAt: Date }): {
    template: ExternalEmailTemplate;
    title: string;
    body: string;
  } {
    return {
      template: { key: 'PASSWORD_RESET', version: '1' },
      title: 'Restablece tu contraseña de UInventario',
      body: [
        'Recibimos una solicitud para restablecer tu contraseña.',
        '',
        `Abre este enlace seguro: ${input.resetUrl}`,
        `El enlace vence el ${input.expiresAt.toISOString()}.`,
        '',
        'Si no solicitaste el cambio, ignora este mensaje.',
      ].join('\n'),
    };
  }

  saleReceipt(receipt: SaleReceiptData): {
    template: ExternalEmailTemplate;
    title: string;
    body: string;
  } {
    return {
      template: { key: 'SALE_RECEIPT', version: '1' },
      title: `Comprobante ${receipt.receiptNumber}`,
      body: [
        receipt.merchant.name,
        receipt.fiscalNotice,
        `Comprobante: ${receipt.receiptNumber}`,
        `Sucursal: ${receipt.branchName}`,
        `Fecha: ${receipt.issuedAt}`,
        '',
        ...receipt.lines.map(
          (line) =>
            `${line.quantity} x ${line.productName} (${line.productSku}): ${line.total} ${receipt.currency}`,
        ),
        '',
        `Total: ${receipt.totals.total} ${receipt.currency}`,
      ].join('\n'),
    };
  }

  operationalNotification(input: { title: string; body: string }): {
    template: ExternalEmailTemplate;
    title: string;
    body: string;
  } {
    return {
      template: { key: 'OPERATIONAL_NOTIFICATION', version: '1' },
      title: input.title,
      body: input.body,
    };
  }
}
