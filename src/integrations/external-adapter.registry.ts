import { Injectable } from '@nestjs/common';
import type {
  ExternalAdapterCapability,
  VersionedExternalAdapter,
} from './external-adapter.types';
import {
  SimulatedEmailExternalAdapter,
  SimulatedPushExternalAdapter,
  SimulatedWhatsAppExternalAdapter,
} from './simulated-notification.adapter';
import { ResendEmailExternalAdapter } from './resend-email.adapter';

@Injectable()
export class ExternalAdapterRegistry {
  private readonly adapters: Map<string, VersionedExternalAdapter>;

  constructor(
    email: SimulatedEmailExternalAdapter,
    push: SimulatedPushExternalAdapter,
    whatsapp: SimulatedWhatsAppExternalAdapter,
    resend: ResendEmailExternalAdapter,
  ) {
    this.adapters = new Map(
      [email, push, whatsapp, resend].map((adapter) => [
        this.key(adapter),
        adapter,
      ]),
    );
  }

  get(input: {
    capability: ExternalAdapterCapability;
    provider: string;
    version: string;
  }): VersionedExternalAdapter | null {
    return (
      this.adapters.get(
        `${input.capability}:${input.provider}:${input.version}`,
      ) ?? null
    );
  }

  catalog() {
    return [...this.adapters.values()].map((adapter) => ({
      capability: adapter.capability,
      provider: adapter.provider,
      version: adapter.version,
      mode:
        adapter.provider === 'SIMULATOR'
          ? ('SIMULATOR' as const)
          : ('LIVE' as const),
    }));
  }

  private key(adapter: VersionedExternalAdapter): string {
    return `${adapter.capability}:${adapter.provider}:${adapter.version}`;
  }
}
