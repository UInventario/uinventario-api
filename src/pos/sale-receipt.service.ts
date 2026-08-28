import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { SALE_RECEIPT_EMAIL_ADAPTER } from './sale-receipt-email.adapter';
import type { SaleReceiptEmailAdapter } from './sale-receipt-email.adapter';
import { SaleReceiptRepository } from './sale-receipt.repository';

@Injectable()
export class SaleReceiptService {
  constructor(
    private readonly receipts: SaleReceiptRepository,
    private readonly audit: AuditService,
    @Inject(SALE_RECEIPT_EMAIL_ADAPTER)
    private readonly email: SaleReceiptEmailAdapter,
  ) {}

  async reprint(input: {
    tenantId: string;
    branchId: string;
    saleId: string;
    userId: string;
    correlationId: string;
  }) {
    const receipt = await this.requireReceipt(input);
    await this.audit.recordRequired({
      tenantId: input.tenantId,
      actorUserId: input.userId,
      action: 'SALE_RECEIPT_REPRINTED',
      entityType: 'SALE',
      entityId: input.saleId,
      correlationId: input.correlationId,
      after: { receiptNumber: receipt.receiptNumber, channel: 'PRINT' },
    });
    return { data: receipt, meta: { apiVersion: '1' as const } };
  }

  async send(input: {
    tenantId: string;
    branchId: string;
    saleId: string;
    userId: string;
    correlationId: string;
    recipient: string;
  }) {
    const receipt = await this.requireReceipt(input);
    const delivery = await this.email.send(receipt, input.recipient);
    await this.audit.recordRequired({
      tenantId: input.tenantId,
      actorUserId: input.userId,
      action: 'SALE_RECEIPT_SENT',
      entityType: 'SALE',
      entityId: input.saleId,
      correlationId: input.correlationId,
      after: {
        receiptNumber: receipt.receiptNumber,
        channel: delivery.channel,
        mode: delivery.mode,
        recipientHash: createHash('sha256')
          .update(input.recipient)
          .digest('hex'),
      },
    });
    return {
      data: { receipt, delivery },
      meta: { apiVersion: '1' as const },
    };
  }

  private async requireReceipt(input: {
    tenantId: string;
    branchId: string;
    saleId: string;
  }) {
    const receipt = await this.receipts.get(
      input.tenantId,
      input.branchId,
      input.saleId,
    );
    if (!receipt) throw new NotFoundException();
    return receipt;
  }
}
