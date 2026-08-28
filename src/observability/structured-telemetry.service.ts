import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { pseudonymizeTenant } from './telemetry-context';

export type TelemetrySeverity = 'INFO' | 'WARNING' | 'ERROR';

export interface TelemetryEvent {
  severity: TelemetrySeverity;
  event: string;
  correlationId?: string;
  traceId?: string;
  spanId?: string;
  tenantRef?: string;
  [key: string]: boolean | number | string | undefined;
}

@Injectable()
export class StructuredTelemetryService {
  private readonly deploymentEnvironment: string;
  private readonly projectId: string | undefined;

  constructor(config: ConfigService) {
    this.deploymentEnvironment = config.getOrThrow<string>(
      'app.deploymentEnvironment',
    );
    this.projectId = process.env.GOOGLE_CLOUD_PROJECT;
  }

  emit(event: TelemetryEvent): void {
    const payload: Record<string, unknown> = {
      ...event,
      environment: this.deploymentEnvironment,
      timestamp: new Date().toISOString(),
    };
    if (this.projectId && event.traceId) {
      payload['logging.googleapis.com/trace'] =
        `projects/${this.projectId}/traces/${event.traceId}`;
    }
    if (event.spanId) {
      payload['logging.googleapis.com/spanId'] = event.spanId;
    }
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  }

  tenantRef(tenantId: string | undefined): string | undefined {
    return pseudonymizeTenant(tenantId, this.deploymentEnvironment);
  }
}
