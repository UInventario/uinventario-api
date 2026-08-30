import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type {
  FiscalAdapterDocument,
  VersionedFiscalProviderAdapter,
} from './fiscal-provider-adapter.types';

@Injectable()
export class SimulatedFiscalAdapter implements VersionedFiscalProviderAdapter {
  readonly provider = 'SIMULATOR';
  readonly version = '1';

  issue(
    input: Parameters<VersionedFiscalProviderAdapter['issue']>[0],
  ): Promise<FiscalAdapterDocument> {
    const providerReference = `SIM-${createHash('sha256')
      .update(`${input.countryCode}:${input.documentType}:${input.reference}`)
      .digest('hex')
      .slice(0, 20)
      .toUpperCase()}`;
    if (input.scenario === 'REJECT') {
      return Promise.resolve({
        providerReference,
        status: 'REJECTED',
        errorCode: 'SIMULATED_REJECTION',
      });
    }
    if (input.scenario === 'TIMEOUT') {
      return Promise.resolve({
        providerReference,
        status: 'INDETERMINATE',
        errorCode: 'SIMULATED_TIMEOUT',
      });
    }
    return Promise.resolve({
      providerReference,
      status: 'ACCEPTED',
      errorCode: null,
      artifacts: this.artifacts(
        providerReference,
        input.countryCode,
        input.documentType,
      ),
    });
  }

  query(
    input: Parameters<VersionedFiscalProviderAdapter['query']>[0],
  ): Promise<FiscalAdapterDocument> {
    if (
      input.currentStatus !== 'INDETERMINATE' ||
      input.scenario !== 'TIMEOUT'
    ) {
      return Promise.resolve({
        providerReference: input.providerReference,
        status: input.currentStatus,
        errorCode:
          input.currentStatus === 'REJECTED' ? 'SIMULATED_REJECTION' : null,
      });
    }
    if (input.pollCount < 2) {
      return Promise.resolve({
        providerReference: input.providerReference,
        status: 'INDETERMINATE',
        errorCode: 'SIMULATED_STILL_PROCESSING',
      });
    }
    return Promise.resolve({
      providerReference: input.providerReference,
      status: 'ACCEPTED',
      errorCode: null,
      artifacts: this.artifacts(
        input.providerReference,
        input.countryCode,
        input.documentType,
      ),
    });
  }

  cancel(
    input: Parameters<VersionedFiscalProviderAdapter['cancel']>[0],
  ): Promise<FiscalAdapterDocument> {
    if (
      !['ACCEPTED', 'INDETERMINATE', 'CANCELLED'].includes(input.currentStatus)
    ) {
      throw new BadRequestException('FISCAL_DOCUMENT_NOT_CANCELLABLE');
    }
    return Promise.resolve({
      providerReference: input.providerReference,
      status: 'CANCELLED',
      errorCode: null,
    });
  }

  download(
    input: Parameters<VersionedFiscalProviderAdapter['download']>[0],
  ): Promise<{ mediaType: string; fileName: string; contentBase64: string }> {
    if (
      !['ACCEPTED', 'CANCELLED'].includes(input.status) ||
      !input.contentBase64
    ) {
      throw new BadRequestException('FISCAL_ARTIFACT_NOT_AVAILABLE');
    }
    return Promise.resolve({
      mediaType: input.kind === 'PDF' ? 'application/pdf' : 'application/xml',
      fileName: `${input.providerReference}.${input.kind.toLowerCase()}`,
      contentBase64: input.contentBase64,
    });
  }

  private artifacts(
    providerReference: string,
    countryCode: string,
    documentType: string,
  ) {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><simulated-fiscal-document provider-reference="${providerReference}" country="${countryCode}" type="${documentType}"/>`;
    const pdf = this.pdf(providerReference);
    return {
      PDF: Buffer.from(pdf).toString('base64'),
      XML: Buffer.from(xml).toString('base64'),
    };
  }

  private pdf(providerReference: string): string {
    const stream = `BT /F1 12 Tf 72 720 Td (UInventario fiscal simulator) Tj 0 -20 Td (${providerReference}) Tj ET`;
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    let content = '%PDF-1.4\n% UInventario simulated fiscal artifact\n';
    const offsets = [0];
    objects.forEach((object, index) => {
      offsets.push(Buffer.byteLength(content));
      content += `${index + 1} 0 obj\n${object}\nendobj\n`;
    });
    const xref = Buffer.byteLength(content);
    content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    content += offsets
      .slice(1)
      .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
      .join('');
    content += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return content;
  }
}
