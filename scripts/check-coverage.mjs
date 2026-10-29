import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const report = JSON.parse(
  readFileSync(resolve('coverage/coverage-summary.json'), 'utf8'),
);
const criticalFiles = [
  'apps/auth/src/auth.service.ts',
  'apps/booking/src/booking-state-machine.ts',
  'apps/booking/src/booking.service.ts',
  'apps/booking/src/ticket-qr.ts',
  'libs/messaging/src/idempotency.ts',
  'libs/outbox/src/outbox-relay.ts',
];
const failures = [];
const overallCoverage = report.total?.lines?.pct;

if (typeof overallCoverage !== 'number') {
  throw new Error('Missing overall line coverage in coverage summary');
}
if (overallCoverage < 70) {
  failures.push(`Overall line coverage is ${overallCoverage}%; required 70%.`);
}

for (const file of criticalFiles) {
  const coverage = report[resolve(file)]?.lines?.pct;
  if (typeof coverage !== 'number') {
    throw new Error(`Missing line coverage for critical file ${file}`);
  }
  if (coverage < 85) {
    failures.push(`${file} line coverage is ${coverage}%; required 85%.`);
  }
}

if (failures.length > 0) {
  throw new Error(failures.join('\n'));
}

console.log(
  `Coverage thresholds met: ${overallCoverage}% overall; all ${criticalFiles.length} critical files at least 85%.`,
);
