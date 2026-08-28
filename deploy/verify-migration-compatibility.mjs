import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const baseRef = process.env.COMPATIBILITY_BASE_REF ?? 'v1.0.0';
const files = execFileSync(
  'git',
  ['diff', '--name-only', baseRef, '--', 'src/database/migrations'],
  { encoding: 'utf8' },
)
  .split(/\r?\n/)
  .map((file) => file.trim())
  .filter((file) => file.endsWith('.ts'))
  .sort();

const destructivePatterns = [
  ['DROP TABLE', /\bDROP\s+TABLE\b/i],
  ['TRUNCATE TABLE', /\bTRUNCATE\s+TABLE\b/i],
  ['RENAME TABLE/COLUMN', /\bRENAME\s+(?:TABLE|COLUMN)\b/i],
  ['DROP COLUMN', /\bDROP\s+COLUMN\s+`?[A-Za-z_][A-Za-z0-9_]*`?\b/i],
  ['MODIFY COLUMN', /\bMODIFY\s+(?:COLUMN\s+)?/i],
  ['CHANGE COLUMN', /\bCHANGE\s+(?:COLUMN\s+)?/i],
];

const violations = [];

for (const file of files) {
  const source = await readFile(join(process.cwd(), file), 'utf8');
  const upStart = source.indexOf('async up(');
  const downStart = source.indexOf('async down(');
  if (upStart < 0 || downStart < 0 || downStart <= upStart) {
    violations.push(`${file}: migration must define up() before down()`);
    continue;
  }

  const upBody = source.slice(upStart, downStart);
  for (const [operation, pattern] of destructivePatterns) {
    if (pattern.test(upBody)) violations.push(`${file}: ${operation} in up()`);
  }
}

if (violations.length > 0) {
  console.error(
    'Breaking migration operations require a phased expand/contract ticket:',
  );
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log(
    `Migration compatibility passed for ${files.length} migration(s) changed since ${baseRef}.`,
  );
}
