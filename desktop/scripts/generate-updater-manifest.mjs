#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
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
  artifact: 'AgSwarm-macOS-Apple-Silicon.app.tar.gz',
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
  const artifactPath = findAsset(artifact);
  const signaturePath = `${artifactPath}.sig`;
  if (!existsSync(artifactPath)) {
    throw new Error(`Missing updater artifact for ${key}: ${artifact}\nAvailable assets:\n${listAssets()}`);
  }
  if (!existsSync(signaturePath)) {
    throw new Error(`Missing updater signature for ${key}: ${path.basename(signaturePath)}\nAvailable assets:\n${listAssets()}`);
  }
  const signature = readFileSync(signaturePath, 'utf8').trim();
  if (!signature || /^https?:\/\//iu.test(signature)) {
    throw new Error(`Invalid updater signature content for ${key}: ${signaturePath}`);
  }
  platforms[key] = {
    signature,
    url: `${baseUrl}/${encodeURIComponent(path.basename(artifactPath))}`,
  };
}

function findAsset(fileName) {
  for (const asset of walkFiles(assetsDir)) {
    if (path.basename(asset) === fileName) return asset;
  }
  return path.join(assetsDir, fileName);
}

function listAssets() {
  const assets = walkFiles(assetsDir).map(asset => `- ${path.relative(assetsDir, asset)}`);
  return assets.length ? assets.join('\n') : '- <none>';
}

function walkFiles(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory)) {
    const fullPath = path.join(directory, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      files.push(...walkFiles(fullPath));
    } else if (stats.isFile()) {
      files.push(fullPath);
    }
  }
  return files.sort();
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
