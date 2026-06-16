#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));
const version = required(args.version || process.env.GITHUB_REF_NAME?.replace(/^v/u, ''), 'version');
const tag = args.tag || process.env.GITHUB_REF_NAME || `v${version}`;
const repo = args.repo || process.env.GITHUB_REPOSITORY || 'yyin9116/AgSwarm';
const assetsDir = path.resolve(args.assetsDir || 'release-assets');
const notesPath = args.notesPath ? path.resolve(args.notesPath) : '';
const outPath = path.resolve(args.out || path.join(assetsDir, 'latest.json'));
const baseUrl = `https://github.com/${repo}/releases/download/${tag}`;

const notes = notesPath && existsSync(notesPath)
  ? readFileSync(notesPath, 'utf8').trim()
  : `AgSwarm ${version}`;

const platforms = {};
addPlatform({
  key: 'darwin-aarch64',
  artifact: 'AgSwarm-macOS-Apple-Silicon.dmg',
});
addPlatform({
  key: 'windows-x86_64',
  artifact: 'AgSwarm-Windows-x64-Setup.exe',
});

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms,
};

writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Generated updater manifest: ${outPath}`);

function addPlatform({ key, artifact }) {
  const artifactPath = path.join(assetsDir, artifact);
  const signaturePath = `${artifactPath}.sig`;
  if (!existsSync(artifactPath)) {
    throw new Error(`Missing updater artifact for ${key}: ${artifactPath}`);
  }
  if (!existsSync(signaturePath)) {
    throw new Error(`Missing updater signature for ${key}: ${signaturePath}`);
  }
  const signature = readFileSync(signaturePath, 'utf8').trim();
  if (!signature || /^https?:\/\//iu.test(signature)) {
    throw new Error(`Invalid updater signature content for ${key}: ${signaturePath}`);
  }
  platforms[key] = {
    signature,
    url: `${baseUrl}/${encodeURIComponent(artifact)}`,
  };
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

function required(value, label) {
  if (!value) throw new Error(`Missing required ${label}`);
  return value;
}
