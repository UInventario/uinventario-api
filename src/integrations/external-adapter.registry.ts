import { Injectable } from '@nestjs/common';
import type {
  ExternalAdapterCapability,
  VersionedExternalAdapter,
} from './external-adapter.types';
import {
  SimulatedEmailExternalAdapter,
  SimulatedPushExternalAdapter,
} from './simulated-notification.adapter';

@Injectable()
export class ExternalAdapterRegistry {
  private readonly adapters: Map<string, VersionedExternalAdapter>;

  constructor(
    email: SimulatedEmailExternalAdapter,
    push: SimulatedPushExternalAdapter,
  ) {
    this.adapters = new Map(
      [email, push].map((adapter) => [this.key(adapter), adapter]),
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
      mode: 'SIMULATOR' as const,
    }));
  }

  private key(adapter: VersionedExternalAdapter): string {
    return `${adapter.capability}:${adapter.provider}:${adapter.version}`;
  }
}
