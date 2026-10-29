import { afterEach, describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('nginx route install rollback', () => {
  it('scopes static security headers and preserves camera and QR support', () => {
    const snippet = readFileSync('infra/nginx/ticketforge-web.conf', 'utf8');
    const location = snippet.slice(
      snippet.indexOf('location ^~ /ticketforge/'),
    );
    expect(location).toContain('server_tokens off;');
    expect(location).toContain("frame-ancestors 'none'");
    expect(location).toContain("img-src 'self' data:");
    expect(location).toContain('camera=(self)');
    expect(location).toContain('add_header X-Frame-Options DENY always;');
    expect(location).toContain(
      'add_header X-Content-Type-Options nosniff always;',
    );
    expect(location).not.toContain("'unsafe-inline'");
    expect(snippet).not.toContain('Strict-Transport-Security');
  });

  it('restores previous snippets and removes newly created snippets when validation fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'ticketforge-nginx-test-'));
    directories.push(root);
    const snippets = join(root, 'snippets');
    const bin = join(root, 'bin');
    mkdirSync(snippets);
    mkdirSync(bin);
    const site = join(root, 'site');
    const originalSite = 'server {\n    location / {\n    }\n}\n';
    writeFileSync(site, originalSite);
    writeFileSync(join(snippets, 'ticketforge-api.conf'), 'previous api\n');
    writeFileSync(join(root, 'ticketforge-api.conf'), 'new api\n');
    writeFileSync(join(root, 'ticketforge-web.conf'), 'invalid web\n');
    writeFileSync(join(bin, 'nginx'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    writeFileSync(join(bin, 'systemctl'), '#!/bin/sh\nexit 99\n', {
      mode: 0o700,
    });
    const script = readFileSync('infra/nginx/install-route.sh', 'utf8')
      .replace('if [[ "$EUID" -ne 0 ]]', 'if false')
      .replaceAll('/etc/nginx/snippets', snippets)
      .replaceAll('install -D -o root -g root', 'install -D');
    const file = join(root, 'install-route.sh');
    writeFileSync(file, script);
    const result = spawnSync('bash', [file], {
      env: {
        ...process.env,
        NGINX_SITE_FILE: site,
        PATH: `${bin}:${process.env.PATH}`,
      },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(readFileSync(site, 'utf8')).toBe(originalSite);
    expect(readFileSync(join(snippets, 'ticketforge-api.conf'), 'utf8')).toBe(
      'previous api\n',
    );
    expect(existsSync(join(snippets, 'ticketforge-web.conf'))).toBe(false);
  });
});
