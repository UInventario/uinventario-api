import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type {
  AccountingEventData,
  AccountingEventStatus,
} from './accounting.types';

export interface AccountingAdapterResult {
  status: AccountingEventStatus;
  providerReference: string | null;
  errorCode: string | null;
}

@Injectable()
export class SimulatedAccountingAdapter {
  readonly provider = 'SIMULATOR' as const;
  readonly version = '1' as const;

  deliver(
    event: AccountingEventData,
    scenario: 'SUCCESS' | 'REJECT' | 'TIMEOUT',
  ): AccountingAdapterResult {
    const providerReference = this.reference(event.eventKey);
    if (scenario === 'REJECT') {
      return {
        status: 'REJECTED',
        providerReference,
        errorCode: 'SIMULATED_ACCOUNTING_REJECTION',
      };
    }
    if (scenario === 'TIMEOUT') {
      return {
        status: 'INDETERMINATE',
        providerReference,
        errorCode: 'SIMULATED_ACCOUNTING_TIMEOUT',
      };
    }
    return { status: 'EXPORTED', providerReference, errorCode: null };
  }

  reconcile(event: AccountingEventData): AccountingAdapterResult {
    return event.status === 'INDETERMINATE'
      ? {
          status: 'EXPORTED',
          providerReference:
            event.providerReference ?? this.reference(event.eventKey),
          errorCode: null,
        }
      : {
          status: event.status,
          providerReference: event.providerReference,
          errorCode: event.errorCode,
        };
  }

  private reference(eventKey: string): string {
    return `ACC-${createHash('sha256').update(eventKey).digest('hex').slice(0, 24).toUpperCase()}`;
  }
}
