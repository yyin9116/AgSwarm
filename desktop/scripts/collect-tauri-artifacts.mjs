#!/usr/bin/env node
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { copyFile, cp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(desktopDir, '..');
const outDir = path.join(repoRoot, 'dist-artifacts');

const args = parseArgs(process.argv.slice(2));
const target = args.target || process.env.TAURI_SIDECAR_TARGET || '';
const label = args.label || labelForTarget(target) || `${os.platform()}-${os.arch()}`;
const releaseName = sanitizeName(args.releaseName || process.env.AG_SWARM_RELEASE_NAME || 'AgSwarm');
const releaseDirs = target
  ? [
      path.join(desktopDir, 'src-tauri', 'target', target, 'release', 'bundle'),
      path.join(desktopDir, 'src-tauri', 'target', 'release', 'bundle'),
    ]
  : [path.join(desktopDir, 'src-tauri', 'target', 'release', 'bundle')];

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const copied = [];
for (const releaseDir of releaseDirs) {
  const before = copied.length;
  if (isMacLabel(label)) {
    await copyMatching(path.join(releaseDir, 'dmg'), ['.dmg']);
    await copyMatching(path.join(releaseDir, 'macos'), ['.app.tar.gz']);
    await copyMatching(path.join(releaseDir, 'macos'), ['.app.tar.gz.sig'], { signatureFor: '.app.tar.gz' });
    await zipMacApps(path.join(releaseDir, 'macos'));
  } else if (isWindowsLabel(label)) {
    await copyMatching(path.join(releaseDir, 'nsis'), ['.exe']);
    await copyMatching(path.join(releaseDir, 'nsis'), ['.sig'], { signatureFor: '.exe' });
    await copyMatching(path.join(releaseDir, 'msi'), ['.msi']);
    await copyMatching(path.join(releaseDir, 'msi'), ['.sig'], { signatureFor: '.msi' });
  } else {
    await copyMatching(path.join(releaseDir, 'appimage'), ['.AppImage']);
    await copyMatching(path.join(releaseDir, 'appimage'), ['.sig'], { signatureFor: '.AppImage' });
    await copyMatching(path.join(releaseDir, 'deb'), ['.deb']);
    await copyMatching(path.join(releaseDir, 'rpm'), ['.rpm']);
  }
  if (copied.length > before) break;
}

if (!copied.length) {
  throw new Error(`No Tauri artifacts found under ${releaseDirs.join(' or ')}`);
}

console.log('Collected Tauri artifacts:');
for (const artifact of copied) console.log(`- ${artifact}`);

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

async function copyMatching(directory, extensions, options = {}) {
  if (!existsSync(directory)) return;
  const entries = await import('node:fs/promises').then(fs => fs.readdir(directory));
  for (const entry of entries) {
    const source = path.join(directory, entry);
    if (!statSync(source).isFile()) continue;
    if (!extensions.some(extension => entry.endsWith(extension))) continue;
    const destination = path.join(outDir, normalizeName(entry, options));
    await copyFile(source, destination);
    copied.push(destination);
  }
}

async function zipMacApps(directory) {
  if (!existsSync(directory)) return;
  const entries = await import('node:fs/promises').then(fs => fs.readdir(directory));
  for (const entry of entries) {
    if (!entry.endsWith('.app')) continue;
    const appPath = path.join(directory, entry);
    if (!statSync(appPath).isDirectory()) continue;
    const zipName = normalizeName(`${entry}.zip`.replace(/\.app\.zip$/u, '.app.zip'));
    const destination = path.join(outDir, zipName);
    if (os.platform() === 'darwin') {
      run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, destination]);
    } else {
      const tempDir = path.join(outDir, `${entry}-bundle`);
      await cp(appPath, path.join(tempDir, entry), { recursive: true });
      run('zip', ['-qry', destination, entry], { cwd: tempDir });
      rmSync(tempDir, { recursive: true, force: true });
    }
    copied.push(destination);
  }
}

function normalizeName(fileName, options = {}) {
  if (fileName.endsWith('.app.tar.gz.sig')) {
    return `${[releaseName, sanitizeName(label)].filter(Boolean).join('-')}.app.tar.gz.sig`;
  }
  if (fileName.endsWith('.app.tar.gz')) {
    return `${[releaseName, sanitizeName(label)].filter(Boolean).join('-')}.app.tar.gz`;
  }
  const extension = path.extname(fileName);
  const base = [releaseName, sanitizeName(label)].filter(Boolean).join('-');
  if (extension === '.sig' && options.signatureFor) {
    if (options.signatureFor === '.exe') return `${base}-Setup.exe.sig`;
    return `${base}${options.signatureFor}.sig`;
  }
  if (extension === '.zip' && fileName.endsWith('.app.zip')) return `${base}.app.zip`;
  if (extension === '.exe') return `${base}-Setup.exe`;
  if (extension) return `${base}${extension}`;
  return `${base}-${sanitizeName(path.basename(fileName))}`;
}

function labelForTarget(value) {
  const labels = {
    'aarch64-apple-darwin': 'macOS-Apple-Silicon',
    'x86_64-pc-windows-msvc': 'Windows-x64',
  };
  return labels[value] || value;
}

function isMacLabel(value) {
  return /macos|darwin|apple/i.test(value);
}

function isWindowsLabel(value) {
  return /windows|win32|msvc/i.test(value);
}

function sanitizeName(value) {
  return String(value)
    .trim()
    .replace(/&/g, 'and')
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '');
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    stdio: 'inherit',
    shell: os.platform() === 'win32',
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(' ')} failed with code ${result.status}`);
  }
}
