import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

/** The directives of a policy as a map, so two policies can be compared directive by directive. */
function directives(policy: string): Record<string, string> {
  return Object.fromEntries(
    policy
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const [name, ...rest] = d.split(/\s+/);
        return [name!, rest.sort().join(' ')];
      }),
  );
}

describe('the content security policies', () => {
  const meta = directives(
    read('index.html').match(/Content-Security-Policy" content="([^"]+)"/)![1]!,
  );
  const header = directives(
    read('public/_headers').match(/Content-Security-Policy: ([^\n]+)/)![1]!,
  );
  const tauri = directives(
    (
      JSON.parse(read('../desktop/src-tauri/tauri.conf.json')) as {
        app: { security: { csp: string } };
      }
    ).app.security.csp,
  );

  it('are the same in the page and the hosting header, apart from what only a header can say', () => {
    const headerRest = Object.fromEntries(
      Object.entries(header).filter(([k]) => k !== 'frame-ancestors'),
    );
    expect(headerRest).toEqual(meta);
    expect(header['frame-ancestors']).toBe("'none'");
  });

  it('allow the local model servers and nothing else over plain http, and blob frames for PDF previews', () => {
    for (const p of [meta, tauri]) {
      expect(p['connect-src']).toContain('http://127.0.0.1:*');
      expect(p['connect-src']).toContain('http://localhost:*');
      expect(
        p['connect-src']!.split(' ').filter(
          (s) =>
            s.startsWith('http://') &&
            !/^(http:\/\/127\.0\.0\.1:\*|http:\/\/localhost:\*|http:\/\/ipc\.localhost)$/.test(s),
        ),
      ).toEqual([]);
      expect(p['frame-src']).toBe("'self' blob:");
      expect(p['default-src']).toBe("'self'");
      // the SQLite WebAssembly needs 'wasm-unsafe-eval'; plain eval and inline scripts stay out
      const scripts = (p['script-src'] ?? "'self'").split(' ');
      expect(scripts).not.toContain("'unsafe-eval'");
      expect(scripts).not.toContain("'unsafe-inline'");
    }
  });
});
