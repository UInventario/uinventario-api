import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const apiUrl = process.argv[2]?.replace(/\/$/, '');
const requests = Number(process.env.PERFORMANCE_REQUESTS ?? 80);
const concurrency = Number(process.env.PERFORMANCE_CONCURRENCY ?? 40);
const p95BudgetMs = Number(process.env.PERFORMANCE_P95_BUDGET_MS ?? 2500);
const recoveryBudgetMs = Number(
  process.env.PERFORMANCE_RECOVERY_BUDGET_MS ?? 5000,
);

if (!apiUrl || !apiUrl.startsWith('https://')) {
  console.error('Usage: node deploy/performance-smoke.mjs <https-api-url>');
  process.exit(2);
}
if (
  !Number.isInteger(requests) ||
  requests < 1 ||
  !Number.isInteger(concurrency) ||
  concurrency < 1 ||
  concurrency > requests
) {
  console.error('Request and concurrency values must be positive integers.');
  process.exit(2);
}

const readinessUrl = `${apiUrl}/health/ready`;

async function timedReadiness() {
  const startedAt = performance.now();
  const response = await fetch(readinessUrl, {
    headers: { 'X-Request-Id': randomUUID() },
  });
  const durationMs = performance.now() - startedAt;
  if (!response.ok) {
    throw new Error(`Readiness returned HTTP ${response.status}.`);
  }
  const body = await response.json();
  if (body.status !== 'ok' || body.info?.database?.status !== 'up') {
    throw new Error('Readiness did not confirm the database dependency.');
  }
  return durationMs;
}

await timedReadiness();

const durations = [];
let nextRequest = 0;
const workers = Array.from(
  { length: Math.min(concurrency, requests) },
  async () => {
    while (nextRequest < requests) {
      nextRequest += 1;
      durations.push(await timedReadiness());
    }
  },
);
await Promise.all(workers);

durations.sort((left, right) => left - right);
const p95 = durations[Math.ceil(durations.length * 0.95) - 1];
if (p95 > p95BudgetMs) {
  throw new Error(
    `Readiness p95 ${p95.toFixed(0)}ms exceeded ${p95BudgetMs}ms.`,
  );
}

const recoveryStartedAt = performance.now();
let recovered = false;
while (performance.now() - recoveryStartedAt <= recoveryBudgetMs) {
  try {
    await timedReadiness();
    recovered = true;
    break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
if (!recovered) {
  throw new Error(`API did not recover within ${recoveryBudgetMs}ms.`);
}

console.log(
  JSON.stringify({
    check: 'performance-smoke',
    requests,
    concurrency,
    p95Ms: Math.round(p95),
    p95BudgetMs,
    recoveryBudgetMs,
    status: 'passed',
  }),
);
