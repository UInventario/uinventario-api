import {
  BadGatewayException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { ExternalAdapterExecutionService } from '../integrations/external-adapter-execution.service';
import { TransactionalEmailTemplateService } from '../integrations/transactional-email-template.service';
import { SaleReceiptRepository } from './sale-receipt.repository';

@Injectable()
export class SaleReceiptService {
  constructor(
    private readonly receipts: SaleReceiptRepository,
    private readonly audit: AuditService,
    private readonly adapters: ExternalAdapterExecutionService,
    private readonly templates: TransactionalEmailTemplateService,
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
    const content = this.templates.saleReceipt(receipt);
    const execution = await this.adapters.execute({
      tenantId: input.tenantId,
      capability: 'NOTIFICATION_EMAIL',
      idempotencyKey: `sale-receipt:${input.correlationId}`,
      correlationId: input.correlationId,
      payload: {
        recipient: input.recipient,
        title: content.title,
        body: content.body,
        template: content.template,
      },
    });
    if (execution.status !== 'SUCCEEDED')
      throw new BadGatewayException({
        code: execution.errorCode ?? 'EMAIL_DELIVERY_FAILED',
        message: 'No fue posible aceptar el correo para entrega.',
      });
    const delivery = {
      mode:
        execution.provider === 'SIMULATOR'
          ? ('SIMULATED' as const)
          : ('PROVIDER' as const),
      channel: 'EMAIL' as const,
      recipient: input.recipient,
      messageId: execution.providerReference!,
      acceptedAt: execution.updatedAt,
    };
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
