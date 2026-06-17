#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));
const assetsDir = path.resolve(required(args.assetsDir, 'assets-dir'));
const expectedVersion = normalizeVersion(args.version || process.env.GITHUB_REF_NAME || '');
const expectedTag = args.tag || process.env.GITHUB_REF_NAME || (expectedVersion ? `v${expectedVersion}` : '');
const expectedPlatforms = ['darwin-aarch64', 'windows-x86_64'];
const latestPath = path.join(assetsDir, 'latest.json');

if (!existsSync(latestPath)) {
  throw new Error(`Missing updater manifest: ${latestPath}`);
}

const manifest = JSON.parse(readFileSync(latestPath, 'utf8'));
if (expectedVersion && manifest.version !== expectedVersion) {
  throw new Error(`Updater manifest version ${manifest.version || '<missing>'} does not match ${expectedVersion}`);
}
for (const platform of expectedPlatforms) {
  if (!manifest.platforms?.[platform]) {
    throw new Error(`Updater manifest is missing required platform entry: ${platform}`);
  }
}
for (const [platform, entry] of Object.entries(manifest.platforms || {})) {
  if (!entry?.url || !entry?.signature) {
    throw new Error(`Invalid updater entry for ${platform}`);
  }
  if (/^https?:\/\//iu.test(entry.signature)) {
    throw new Error(`Updater signature for ${platform} must be signature content, not a URL`);
  }
  const url = new URL(entry.url);
  if (expectedTag && !url.pathname.includes(`/releases/download/${expectedTag}/`)) {
    throw new Error(`Updater URL for ${platform} does not point at ${expectedTag}: ${entry.url}`);
  }
  const fileName = decodeURIComponent(url.pathname.split('/').pop() || '');
  const assetPath = findAsset(fileName);
  if (!assetPath) {
    throw new Error(`Updater URL for ${platform} points to an asset that was not staged: ${fileName}`);
  }
  const signaturePath = findAsset(`${fileName}.sig`);
  if (!signaturePath) {
    throw new Error(`Updater URL for ${platform} is missing staged signature asset: ${fileName}.sig`);
  }
}

console.log(`Verified release updater assets in ${assetsDir}`);

function findAsset(fileName) {
  return walkFiles(assetsDir).find(asset => path.basename(asset) === fileName);
}

function walkFiles(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory)) {
    const fullPath = path.join(directory, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) files.push(...walkFiles(fullPath));
    if (stats.isFile()) files.push(fullPath);
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

function normalizeVersion(value) {
  return String(value).trim().replace(/^refs\/tags\//u, '').replace(/^v/u, '');
}
