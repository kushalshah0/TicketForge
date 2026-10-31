import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const services = [
  'auth',
  'booking',
  'catalog',
  'gateway',
  'notification',
  'payment',
];

const migrationConfigServices = new Map([
  ['drizzle.config.ts', 'auth'],
  ['drizzle.catalog.config.ts', 'catalog'],
  ['drizzle.booking.config.ts', 'booking'],
  ['drizzle.payment.config.ts', 'payment'],
  ['drizzle.notification.config.ts', 'notification'],
]);

const sharedBackendFiles = new Set([
  '.dockerignore',
  'Dockerfile',
  'package-lock.json',
  'package.json',
  'nest-cli.json',
  'tsconfig.build.json',
  'tsconfig.json',
  'scripts/migrate.mjs',
  'infra/compose/docker-compose.prod.yml',
  'infra/scripts/deploy.sh',
  'infra/scripts/deploy-remote.sh',
  'infra/scripts/smoke.sh',
]);

const sharedWebFiles = new Set([
  'package-lock.json',
  'package.json',
  'tsconfig.json',
]);

function isTestFile(path) {
  return (
    /(?:^|\/)(?:__tests__|e2e|test|tests)(?:\/|$)/.test(path) ||
    /(?:^|\/)[^/]*\.(?:spec|test|e2e)\.[^/]+$/.test(path) ||
    /(?:^|\/)playwright\.config\.[^/]+$/.test(path)
  );
}

export function classifyChangedPaths(paths) {
  const selectedServices = new Set();
  let web = false;
  const selectAll = () =>
    services.forEach((service) => selectedServices.add(service));

  for (const path of paths) {
    if (
      path.startsWith('docs/') ||
      path === 'AGENTS.md' ||
      path === 'README.md' ||
      path === '.github/dependabot.yml' ||
      path === '.editorconfig' ||
      path === '.prettierrc' ||
      path === '.gitignore' ||
      path === '.husky/commit-msg' ||
      path === '.husky/pre-commit' ||
      path === '.lintstagedrc.json' ||
      path === 'commitlint.config.js' ||
      path === 'eslint.config.mjs' ||
      path === 'jest.config.ts'
    ) {
      continue;
    }

    if (isTestFile(path)) continue;

    if (path.startsWith('.github/workflows/')) {
      selectAll();
      web = true;
      continue;
    }

    if (path.startsWith('web/')) {
      if (!isTestFile(path) && !path.startsWith('web/e2e/')) web = true;
      continue;
    }

    const appMatch =
      /^apps\/(auth|booking|catalog|gateway|notification|payment)\//.exec(path);
    if (appMatch) {
      selectedServices.add(appMatch[1]);
      continue;
    }

    if (path.startsWith('libs/')) {
      selectAll();
      continue;
    }

    if (sharedBackendFiles.has(path)) {
      selectAll();
      if (sharedWebFiles.has(path)) web = true;
      continue;
    }

    if (migrationConfigServices.has(path)) {
      selectedServices.add(migrationConfigServices.get(path));
      continue;
    }

    if (path === 'infra/scripts/deploy-web.sh') {
      web = true;
      continue;
    }

    if (
      path === '.env.example' ||
      path === '.nvmrc' ||
      path === '.eslintrc.js' ||
      path === '.oxlintrc.json'
    ) {
      selectAll();
      web = true;
      continue;
    }

    if (path.startsWith('infra/')) {
      selectAll();
      continue;
    }

    if (path.startsWith('scripts/')) {
      selectAll();
      continue;
    }

    // Unknown build inputs default to a full release rather than risk a stale image.
    selectAll();
    web = true;
  }

  return {
    services: services.filter((service) => selectedServices.has(service)),
    web,
  };
}

function changedPaths(base, head) {
  if (!base || /^0+$/.test(base)) return null;
  return execFileSync('git', ['diff', '--name-only', '-z', base, head], {
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [, , base, head] = process.argv;
  if (!head) {
    throw new Error('Usage: node changed-components.mjs <base-sha> <head-sha>');
  }
  const plan = changedPaths(base, head);
  const result =
    plan === null ? { services, web: true } : classifyChangedPaths(plan);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
