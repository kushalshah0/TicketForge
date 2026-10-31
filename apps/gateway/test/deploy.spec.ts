import { afterEach, describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function runDeployment(fail: boolean, tag = 'next') {
  const root = mkdtempSync(join(tmpdir(), 'ticketforge-deploy-test-'));
  directories.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  mkdirSync(join(root, 'infra/scripts'), { recursive: true });
  writeFileSync(
    join(root, '.env'),
    'TAG=previous\nPUBLIC_HOSTNAME=example.test\n',
  );
  writeFileSync(join(root, 'infra/scripts/smoke.sh'), '#!/bin/sh\nexit 0\n', {
    mode: 0o700,
  });
  writeFileSync(join(bin, 'curl'), '#!/bin/sh\nprintf 401\n', { mode: 0o700 });
  writeFileSync(
    join(bin, 'docker'),
    `#!/usr/bin/env bash
printf '%s %s\\n' "$TAG" "$*" >> "$TICKETFORGE_ROOT/commands"
if [[ "$*" == *" ps "* ]]; then
  case "\${@: -1}" in auth|catalog|booking|gateway) echo existing-container;; esac
fi
if [[ "$FAIL_DEPLOY" == true && "$TAG" == next && "$*" == *" up "* ]]; then exit 1; fi
`,
    { mode: 0o700 },
  );
  const result = spawnSync('bash', [resolve('infra/scripts/deploy.sh'), tag], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TICKETFORGE_ROOT: root,
      FAIL_DEPLOY: String(fail),
    },
    encoding: 'utf8',
  });
  return {
    result,
    commands:
      tag === 'previous' ? '' : readFileSync(join(root, 'commands'), 'utf8'),
    root,
  };
}

describe('production deployment rollout', () => {
  it('includes all six apps and new database migrations before marking a tag healthy', () => {
    const { result, commands, root } = runDeployment(false);
    expect(result.status).toBe(0);
    expect(commands).toContain(
      'pull auth migrate-auth catalog migrate-catalog booking migrate-booking payment migrate-payment notification migrate-notification gateway',
    );
    expect(commands).toContain(
      'up --detach --no-build --wait --wait-timeout 180 auth catalog booking payment notification gateway',
    );
    expect(readFileSync(join(root, '.last_good_tag'), 'utf8')).toBe('next\n');
  });

  it('stops newly introduced services and restores only the previously running apps on failure', () => {
    const { result, commands } = runDeployment(true);
    expect(result.status).toBe(1);
    expect(commands).toContain('previous compose --env-file');
    for (const service of ['auth', 'catalog', 'booking', 'gateway'])
      expect(commands).toContain(
        `--no-deps --wait --wait-timeout 120 ${service}\n`,
      );
    for (const service of ['payment', 'notification'])
      expect(commands).toContain(`stop ${service}\n`);
  });

  it('rejects reuse of the last healthy tag before changing the deployment', () => {
    const { result, commands } = runDeployment(false, 'previous');
    expect(result.status).toBe(2);
    expect(commands).toBe('');
  });
});
