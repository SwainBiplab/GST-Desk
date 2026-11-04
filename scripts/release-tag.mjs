#!/usr/bin/env node
/**
 * Run by changesets/action's `publish` step once the version PR has merged: tag the commit
 * `v<version>` and push the tag. Nothing is published to a registry. Exits 0 even when the tag
 * already exists so reruns are safe.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const { version } = JSON.parse(readFileSync(join(root, 'apps', 'desktop', 'package.json'), 'utf8'));
const tag = `v${version}`;
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

if (git('tag', '--list', tag) === tag || git('ls-remote', '--tags', 'origin', tag) !== '') {
  console.log(`${tag} already exists, nothing to do`);
  process.exit(0);
}
git('tag', tag);
git('push', 'origin', tag);
// changesets/action reads this line to decide that something was "published"
console.log(`New tag: ${tag}`);
