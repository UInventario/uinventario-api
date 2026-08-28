import { createHash } from 'node:crypto';
import type { RequestContext } from '../security/request-context';

const CLOUD_TRACE_PATTERN = /^([a-f0-9]{32})(?:\/([0-9]+))?(?:;o=[01])?$/i;

export function pseudonymizeTenant(
  tenantId: string | undefined,
  deploymentEnvironment: string,
): string | undefined {
  if (!tenantId) return undefined;
  return `tenant_${createHash('sha256')
    .update(`${deploymentEnvironment}:${tenantId}`)
    .digest('hex')
    .slice(0, 16)}`;
}

export function resolveRequestRoute(request: RequestContext): string {
  const route = request.route as { path?: unknown } | undefined;
  return typeof route?.path === 'string'
    ? `${request.baseUrl}${route.path}`
    : 'unmatched';
}

export function resolveOperation(route: string): string {
  if (route.includes('/auth/')) return 'authentication';
  if (route.includes('/offline/')) return 'offline_sync';
  if (route.includes('/pos/')) return 'pos';
  if (route.includes('/inventory/')) return 'inventory';
  if (route.includes('/data-exports') || route.includes('/password-resets')) {
    return 'integration';
  }
  return 'general';
}

export function resolveTraceContext(request: RequestContext): {
  traceId: string;
  spanId?: string;
} {
  const header = request.header('x-cloud-trace-context');
  const match = header?.match(CLOUD_TRACE_PATTERN);
  if (match) return { traceId: match[1].toLowerCase(), spanId: match[2] };

  return {
    traceId: createHash('sha256')
      .update(request.requestId ?? 'missing-request-id')
      .digest('hex')
      .slice(0, 32),
  };
}
