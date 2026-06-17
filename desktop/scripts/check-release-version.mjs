#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, '..');
const args = parseArgs(process.argv.slice(2));
const expectedVersion = normalizeVersion(args.version || process.env.GITHUB_REF_NAME || '');

if (!expectedVersion) {
  throw new Error('Missing release version. Pass --version vX.Y.Z or set GITHUB_REF_NAME.');
}

const versions = {
  'desktop/package.json': JSON.parse(readFileSync(path.join(desktopDir, 'package.json'), 'utf8')).version,
  'desktop/src-tauri/tauri.conf.json': JSON.parse(readFileSync(path.join(desktopDir, 'src-tauri', 'tauri.conf.json'), 'utf8')).version,
  'desktop/src-tauri/Cargo.toml': readCargoVersion(path.join(desktopDir, 'src-tauri', 'Cargo.toml')),
};

const mismatches = Object.entries(versions).filter(([, value]) => value !== expectedVersion);
if (mismatches.length) {
  const lines = mismatches.map(([file, value]) => `- ${file}: ${value || '<missing>'}`);
  throw new Error(
    [
      `Release version mismatch for ${expectedVersion}.`,
      ...lines,
      'Update all app metadata before pushing a release tag.',
    ].join('\n'),
  );
}

console.log(`Release version check passed: ${expectedVersion}`);

function readCargoVersion(filePath) {
  const match = readFileSync(filePath, 'utf8').match(/^version\s*=\s*"([^"]+)"/m);
  return match?.[1] || '';
}

function normalizeVersion(value) {
  return String(value).trim().replace(/^refs\/tags\//u, '').replace(/^v/u, '');
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--')) continue;
    const key = value.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const next = values[index + 1];
    parsed[key] = next && !next.startsWith('--') ? values[++index] : 'true';
  }
  return parsed;
}
