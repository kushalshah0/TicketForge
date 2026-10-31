import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { classifyChangedPaths, services } from './changed-components.mjs';
import {
  getCurrentMainSha,
  getLastSuccessfulDeploySha,
  initialCommit,
} from './last-successful-deploy.mjs';

const classifierPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'changed-components.mjs',
);

describe('classifyChangedPaths', () => {
  it('selects only the service with runtime changes', () => {
    assert.deepEqual(
      classifyChangedPaths(['apps/booking/src/booking.service.ts']),
      { services: ['booking'], web: false },
    );
  });

  it('selects all backend services for shared library changes', () => {
    assert.deepEqual(classifyChangedPaths(['libs/contracts/src/events.ts']), {
      services,
      web: false,
    });
  });

  describe('getLastSuccessfulDeploySha', () => {
    it('uses the latest successful main deployment', async () => {
      const sha = '0123456789abcdef0123456789abcdef01234567';
      const requests = [];
      const actual = await getLastSuccessfulDeploySha({
        apiUrl: 'https://api.github.com',
        repository: 'owner/repo',
        token: 'test-token',
        fetchImpl: async (url, options) => {
          requests.push(url.href);
          assert.equal(options.headers.Authorization, 'Bearer test-token');
          if (url.pathname.endsWith('/runs')) {
            return {
              ok: true,
              json: async () => ({
                workflow_runs: [
                  {
                    id: 2,
                    head_sha: 'abcdef0123456789abcdef0123456789abcdef01',
                  },
                  { id: 1, head_sha: sha },
                ],
              }),
            };
          }
          return {
            ok: true,
            json: async () => ({
              jobs: [
                {
                  name: 'Deploy production',
                  conclusion: url.pathname.endsWith('/1/jobs')
                    ? 'success'
                    : 'skipped',
                },
              ],
            }),
          };
        },
      });
      assert.equal(actual, sha);
      assert.deepEqual(requests, [
        'https://api.github.com/repos/owner/repo/actions/workflows/deploy.yml/runs?branch=main&status=success&per_page=100',
        'https://api.github.com/repos/owner/repo/actions/runs/2/jobs?per_page=100',
        'https://api.github.com/repos/owner/repo/actions/runs/1/jobs?per_page=100',
      ]);
    });

    it('uses the initial baseline when no successful deployment exists', async () => {
      const actual = await getLastSuccessfulDeploySha({
        apiUrl: 'https://api.github.com',
        repository: 'owner/repo',
        token: 'test-token',
        fetchImpl: async () => ({
          ok: true,
          json: async () => ({ workflow_runs: [] }),
        }),
      });
      assert.equal(actual, initialCommit);
    });

    it('does not count a successful workflow with a skipped deploy job', async () => {
      const actual = await getLastSuccessfulDeploySha({
        apiUrl: 'https://api.github.com',
        repository: 'owner/repo',
        token: 'test-token',
        fetchImpl: async (url) => ({
          ok: true,
          json: async () =>
            url.pathname.endsWith('/runs')
              ? {
                  workflow_runs: [
                    {
                      id: 3,
                      head_sha: '0123456789abcdef0123456789abcdef01234567',
                    },
                  ],
                }
              : {
                  jobs: [{ name: 'Deploy production', conclusion: 'skipped' }],
                },
        }),
      });
      assert.equal(actual, initialCommit);
    });

    it('fails explicitly when the deployment history request fails', async () => {
      await assert.rejects(
        getLastSuccessfulDeploySha({
          apiUrl: 'https://api.github.com',
          repository: 'owner/repo',
          token: 'test-token',
          fetchImpl: async () => ({ ok: false, status: 403 }),
        }),
        /HTTP 403/,
      );
    });
  });

  describe('getCurrentMainSha', () => {
    it('returns the current main commit', async () => {
      const sha = '0123456789abcdef0123456789abcdef01234567';
      const actual = await getCurrentMainSha({
        apiUrl: 'https://api.github.com',
        repository: 'owner/repo',
        token: 'test-token',
        fetchImpl: async (url) => {
          assert.equal(
            url.href,
            'https://api.github.com/repos/owner/repo/commits/main',
          );
          return { ok: true, json: async () => ({ sha }) };
        },
      });
      assert.equal(actual, sha);
    });
  });

  it('selects only web for frontend source changes', () => {
    assert.deepEqual(classifyChangedPaths(['web/src/App.tsx']), {
      services: [],
      web: true,
    });
  });

  it('selects only web when its deployer changes', () => {
    assert.deepEqual(classifyChangedPaths(['infra/scripts/deploy-web.sh']), {
      services: [],
      web: true,
    });
  });

  it('does not deploy for docs and test-only changes', () => {
    assert.deepEqual(
      classifyChangedPaths([
        'docs/design.md',
        'apps/auth/src/auth.service.spec.ts',
        'apps/gateway/test/app.e2e.mjs',
        'web/playwright.config.mjs',
        'web/e2e/journey.e2e.mjs',
        'scripts/release/changed-components.test.mjs',
      ]),
      { services: [], web: false },
    );
  });

  it('selects all backend services for root build changes', () => {
    assert.deepEqual(classifyChangedPaths(['package-lock.json']), {
      services,
      web: true,
    });
  });

  it('selects only the service affected by its migration config', () => {
    assert.deepEqual(classifyChangedPaths(['drizzle.payment.config.ts']), {
      services: ['payment'],
      web: false,
    });
  });

  it('defaults unknown paths to a full release', () => {
    assert.deepEqual(classifyChangedPaths(['new-build-input.config']), {
      services,
      web: true,
    });
  });

  it('classifies the full push range and treats an initial push as a full release', () => {
    const repository = mkdtempSync(`${tmpdir()}/ticketforge-release-plan-`);
    const git = (...args) => execFileSync('git', args, { cwd: repository });
    const commit = (message) =>
      git(
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.test',
        'commit',
        '-am',
        message,
      );
    try {
      git('init', '-q');
      writeFileSync(`${repository}/README.md`, 'initial\n');
      git('add', 'README.md');
      commit('initial');
      const base = git('rev-parse', 'HEAD').toString().trim();

      mkdirSync(`${repository}/apps/auth/src`, { recursive: true });
      writeFileSync(`${repository}/apps/auth/src/auth.service.ts`, 'auth\n');
      git('add', '.');
      commit('auth change');
      mkdirSync(`${repository}/web/src`, { recursive: true });
      writeFileSync(`${repository}/web/src/App.tsx`, 'web\n');
      git('add', '.');
      commit('web change');
      const head = git('rev-parse', 'HEAD').toString().trim();

      const result = (before) =>
        JSON.parse(
          execFileSync(process.execPath, [classifierPath, before, head], {
            cwd: repository,
            encoding: 'utf8',
          }),
        );
      assert.deepEqual(result(base), { services: ['auth'], web: true });
      assert.deepEqual(result('0000000000000000000000000000000000000000'), {
        services,
        web: true,
      });
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });
});
