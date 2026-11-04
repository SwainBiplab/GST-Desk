import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { setCargoVersion, setTauriVersion, syncVersions } from '../lib/version.mjs';

const root = join(import.meta.dirname, '..', '..');
const wfDir = join(root, '.github', 'workflows');
const files = readdirSync(wfDir).filter((f) => f.endsWith('.yml'));
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const workflows = Object.fromEntries(
  files.map((f) => [
    f,
    {
      text: readFileSync(join(wfDir, f), 'utf8'),
      doc: parse(readFileSync(join(wfDir, f), 'utf8')),
    },
  ]),
);

describe('workflow files', () => {
  it('has the expected workflows', () => {
    expect(files.sort()).toEqual(['ci.yml', 'desktop.yml', 'perf.yml', 'release.yml']);
  });

  describe.each(Object.entries(workflows))('%s', (_name, { text, doc }) => {
    it('declares least-privilege permissions at the top level', () => {
      expect(doc.permissions).toBeDefined();
      expect(Object.values(doc.permissions).every((v) => v === 'read' || v === 'none')).toBe(true);
    });

    it('limits every job in time', () => {
      for (const [id, job] of Object.entries(doc.jobs)) {
        if (job.uses) continue; // reusable-workflow calls take their limits from the callee
        expect(job['timeout-minutes'], `${id} has no timeout`).toBeGreaterThan(0);
        expect(job['timeout-minutes']).toBeLessThanOrEqual(60);
      }
    });

    it('pins third-party actions to a full commit SHA (first-party actions/* to a major tag)', () => {
      const uses = [...text.matchAll(/uses:\s*([^\s#]+)/g)]
        .map((m) => m[1])
        .filter((u) => !u.startsWith('./'));
      expect(uses.length).toBeGreaterThan(0);
      for (const u of uses) {
        if (u.startsWith('actions/')) expect(u, u).toMatch(/@v\d+$/);
        else expect(u, u).toMatch(/@[0-9a-f]{40}$/);
      }
    });

    it('never prints secrets', () => {
      for (const line of text.split('\n')) {
        if (/^\s*(run:|echo)/.test(line) || /\becho\b/.test(line)) {
          expect(line, line).not.toMatch(/secrets\./);
        }
      }
      // secrets only appear in env/with/secrets mappings, never inside a run script body
      for (const job of Object.values(doc.jobs)) {
        for (const step of job.steps ?? []) {
          if (step.run) expect(step.run).not.toMatch(/\$\{\{\s*secrets\./);
        }
      }
    });
  });
});

describe('ci.yml', () => {
  const ci = workflows['ci.yml'].doc;
  const text = workflows['ci.yml'].text;

  it('runs on pull requests and pushes to main', () => {
    expect(Object.keys(ci.on).sort()).toEqual(['pull_request', 'push']);
    expect(ci.on.push.branches).toEqual(['main']);
  });

  it('only calls scripts that exist, so local runs match CI', () => {
    const called = [...text.matchAll(/run:\s*pnpm (ci:[\w-]+)/g)].map((m) => m[1]);
    expect(called.length).toBeGreaterThan(4);
    for (const s of called) expect(rootPkg.scripts[s], `missing root script ${s}`).toBeDefined();
  });

  it('uploads coverage and the Playwright report, and caches browsers', () => {
    expect(text).toMatch(/name: coverage/);
    expect(text).toMatch(/name: playwright-report/);
    expect(text).toMatch(/ms-playwright/);
    expect(text).toMatch(/cache: pnpm/);
  });
});

describe('release wiring', () => {
  it('desktop.yml builds all three platforms and never creates a release', () => {
    const d = workflows['desktop.yml'].doc;
    const include = d.jobs.build.strategy.matrix.include;
    expect(include.map((m) => m.artifact)).toEqual(['linux', 'windows', 'macos']);
    expect(include[0].bundles).toBe('appimage,deb');
    expect(include[1].bundles).toBe('msi,nsis');
    expect(include[2].target).toBe('universal-apple-darwin');
    expect(workflows['desktop.yml'].text).not.toMatch(/releaseDraft|gh release|tagName/);
    expect(d.on.workflow_call).toBeDefined();
    // signing secrets are visible to the Build step only, not to every action in the job
    expect(d.jobs.build.env).toBeUndefined();
    const build = d.jobs.build.steps.find((st) => st.name === 'Build');
    for (const k of ['TAURI_SIGNING_PRIVATE_KEY', 'APPLE_CERTIFICATE', 'WINDOWS_CERTIFICATE'])
      expect(build.env[k]).toContain('secrets.');
    for (const st of d.jobs.build.steps)
      if (st !== build) expect(JSON.stringify(st.env ?? {})).not.toContain('secrets.');
  });

  it('release.yml only drafts', () => {
    const t = workflows['release.yml'].text;
    expect(t).toMatch(/--draft/);
    expect(t).not.toMatch(/--draft=false|releaseDraft:\s*false/);
    for (const s of ['release:version', 'release:tag']) expect(rootPkg.scripts[s]).toBeDefined();
    expect(t).toMatch(/make-updater-manifest/);
    expect(t).toMatch(/verify-release/);
  });

  it('perf.yml runs pnpm perf and stores a history artifact', () => {
    const t = workflows['perf.yml'].text;
    expect(t).toMatch(/pnpm perf/);
    expect(t).toMatch(/perf-history/);
    expect(rootPkg.scripts.perf).toBeDefined();
  });
});

describe('version sync', () => {
  const toml = `[package]\nname = "gst-desk"\nversion = "0.0.0"\nedition = "2021"\n\n[dependencies]\ntauri = { version = "2" }\nlog = "0.4"\n`;

  it('rewrites only the package version in Cargo.toml', () => {
    const out = setCargoVersion(toml, '1.4.0');
    expect(out).toContain('name = "gst-desk"\nversion = "1.4.0"');
    expect(out).toContain('tauri = { version = "2" }');
    expect(out).toContain('log = "0.4"');
    expect(() => setCargoVersion('[dependencies]\n', '1.0.0')).toThrow(/\[package\]/);
    expect(() => setCargoVersion('[package]\nname = "x"\n', '1.0.0')).toThrow(/version/);
  });

  it('rewrites tauri.conf.json and syncs files from package.json', () => {
    expect(JSON.parse(setTauriVersion('{"version":"0.0.0","a":1}', '2.0.1'))).toEqual({
      version: '2.0.1',
      a: 1,
    });
    const dir = mkdtempSync(join(tmpdir(), 'ver-'));
    try {
      writeFileSync(join(dir, 'package.json'), '{"version":"3.1.4"}');
      writeFileSync(join(dir, 'tauri.conf.json'), '{"version":"0.0.0"}');
      writeFileSync(join(dir, 'Cargo.toml'), toml);
      const v = syncVersions({
        packageJson: join(dir, 'package.json'),
        tauriConf: join(dir, 'tauri.conf.json'),
        cargoToml: join(dir, 'Cargo.toml'),
      });
      expect(v).toBe('3.1.4');
      expect(readFileSync(join(dir, 'tauri.conf.json'), 'utf8')).toContain('"3.1.4"');
      expect(readFileSync(join(dir, 'Cargo.toml'), 'utf8')).toContain('version = "3.1.4"');
      writeFileSync(join(dir, 'package.json'), '{"version":"oops"}');
      expect(() =>
        syncVersions({
          packageJson: join(dir, 'package.json'),
          tauriConf: join(dir, 'tauri.conf.json'),
          cargoToml: join(dir, 'Cargo.toml'),
        }),
      ).toThrow(/bad version/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
