import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type {
  ExternalAdapterCapability,
  ExternalAdapterCommand,
  ExternalAdapterResult,
  VersionedExternalAdapter,
} from './external-adapter.types';

abstract class SimulatedNotificationAdapter implements VersionedExternalAdapter {
  abstract readonly capability: ExternalAdapterCapability;
  readonly provider = 'SIMULATOR';
  readonly version = '1';

  async execute(
    command: ExternalAdapterCommand,
    signal: AbortSignal,
  ): Promise<ExternalAdapterResult> {
    if (command.scenario === 'TIMEOUT') await this.delay(60_000, signal);
    if (command.scenario === 'REJECT')
      return { status: 'REJECTED', errorCode: 'SIMULATED_REJECTED' };
    if (command.scenario === 'RETRY' && command.attempt === 1)
      return {
        status: 'RETRYABLE_FAILURE',
        errorCode: 'SIMULATED_PROVIDER_UNAVAILABLE',
      };
    const reference = createHash('sha256')
      .update(
        `${command.tenantId}:${this.capability}:${command.idempotencyKey}`,
      )
      .digest('hex')
      .slice(0, 24);
    return { status: 'SUCCEEDED', providerReference: `SIM-${reference}` };
  }

  private delay(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, milliseconds);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new Error('ADAPTER_ABORTED'));
        },
        { once: true },
      );
    });
  }
}

@Injectable()
export class SimulatedEmailExternalAdapter extends SimulatedNotificationAdapter {
  readonly capability = 'NOTIFICATION_EMAIL' as const;
}

@Injectable()
export class SimulatedPushExternalAdapter extends SimulatedNotificationAdapter {
  readonly capability = 'NOTIFICATION_PUSH' as const;
}

@Injectable()
export class SimulatedWhatsAppExternalAdapter extends SimulatedNotificationAdapter {
  readonly capability = 'NOTIFICATION_WHATSAPP' as const;
}
