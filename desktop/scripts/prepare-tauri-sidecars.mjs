#!/usr/bin/env node
import { createWriteStream, existsSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { access, cp } from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, '..');
const binariesDir = path.join(desktopDir, 'src-tauri', 'binaries');
const bridgeEntry = path.join(desktopDir, 'scripts', 'pi-agent-session-bridge.mjs');
const workDir = path.join(desktopDir, 'src-tauri', 'target', 'sidecar-work');

const TARGETS = {
  'aarch64-apple-darwin': {
    bunTarget: 'darwin-arm64',
    nodeExecutable: ['bin', 'node'],
    nodeArchive: version => `node-v${version}-darwin-arm64.tar.gz`,
    bridgeName: 'pi-agent-session-bridge-aarch64-apple-darwin',
    nodeName: 'node-aarch64-apple-darwin',
  },
  'x86_64-apple-darwin': {
    bunTarget: 'darwin-x64',
    nodeExecutable: ['bin', 'node'],
    nodeArchive: version => `node-v${version}-darwin-x64.tar.gz`,
    bridgeName: 'pi-agent-session-bridge-x86_64-apple-darwin',
    nodeName: 'node-x86_64-apple-darwin',
  },
  'x86_64-pc-windows-msvc': {
    bunTarget: 'windows-x64',
    nodeExecutable: ['node.exe'],
    nodeArchive: version => `node-v${version}-win-x64.zip`,
    bridgeName: 'pi-agent-session-bridge-x86_64-pc-windows-msvc.exe',
    nodeName: 'node-x86_64-pc-windows-msvc.exe',
  },
  'x86_64-unknown-linux-gnu': {
    bunTarget: 'linux-x64',
    nodeExecutable: ['bin', 'node'],
    nodeArchive: version => `node-v${version}-linux-x64.tar.xz`,
    bridgeName: 'pi-agent-session-bridge-x86_64-unknown-linux-gnu',
    nodeName: 'node-x86_64-unknown-linux-gnu',
  },
};

const args = parseArgs(process.argv.slice(2));
const target = args.target || process.env.TAURI_SIDECAR_TARGET || currentTarget();
const config = TARGETS[target];
const DEFAULT_NODE_VERSION = '22.19.0';

if (!config) {
  throw new Error(`Unsupported sidecar target: ${target}`);
}

mkdirSync(binariesDir, { recursive: true });
mkdirSync(workDir, { recursive: true });

const nodeVersion = (args.nodeVersion || process.env.NODE_VERSION || DEFAULT_NODE_VERSION).replace(/^v/, '');
const skipNode = args.skipNode === 'true';
const skipBridge = args.skipBridge === 'true';

if (!skipNode) {
  await prepareNodeSidecar(target, config, nodeVersion);
}

if (!skipBridge) {
  prepareBridgeSidecar(target, config);
}

console.log(`Prepared Tauri sidecars for ${target}.`);

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

function currentTarget() {
  const platform = os.platform();
  const arch = os.arch();
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin';
  if (platform === 'darwin' && arch === 'x64') return 'x86_64-apple-darwin';
  if (platform === 'win32' && arch === 'x64') return 'x86_64-pc-windows-msvc';
  if (platform === 'linux' && arch === 'x64') return 'x86_64-unknown-linux-gnu';
  throw new Error(`Unsupported host platform: ${platform} ${arch}`);
}

async function prepareNodeSidecar(target, targetConfig, version) {
  const destination = path.join(binariesDir, targetConfig.nodeName);
  if (existsSync(destination) && args.force !== 'true') {
    console.log(`Node sidecar already exists for ${target}: ${destination}`);
    return;
  }

  const archiveName = targetConfig.nodeArchive(version);
  const archiveUrl = `https://nodejs.org/dist/v${version}/${archiveName}`;
  const archivePath = path.join(workDir, archiveName);
  const extractDir = path.join(workDir, `${target}-node`);
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });

  console.log(`Downloading ${archiveUrl}`);
  await download(archiveUrl, archivePath);
  extractArchive(archivePath, extractDir);

  const packageDir = path.join(extractDir, archiveName.replace(/\.tar\.gz$|\.tar\.xz$|\.zip$/u, ''));
  const nodePath = path.join(packageDir, ...targetConfig.nodeExecutable);
  await access(nodePath);
  await cp(nodePath, destination, { force: true });
  if (!destination.endsWith('.exe')) chmodSync(destination, 0o755);
}

function prepareBridgeSidecar(target, targetConfig) {
  const destination = path.join(binariesDir, targetConfig.bridgeName);
  const bunArgs = [
    'build',
    '--compile',
    `--target=bun-${targetConfig.bunTarget}`,
    bridgeEntry,
    '--outfile',
    destination,
  ];
  run('bun', bunArgs, { cwd: desktopDir });
  if (!destination.endsWith('.exe')) chmodSync(destination, 0o755);
  console.log(`Bridge sidecar ready for ${target}: ${destination}`);
}

function download(url, destination) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode || 0) && response.headers.location) {
        response.resume();
        download(response.headers.location, destination).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Download failed with HTTP ${response.statusCode}: ${url}`));
        return;
      }
      const output = createWriteStream(destination);
      response.pipe(output);
      output.on('finish', () => output.close(resolve));
      output.on('error', reject);
    });
    request.on('error', reject);
  });
}

function extractArchive(archivePath, destination) {
  if (archivePath.endsWith('.zip') && os.platform() === 'win32') {
    run('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force '${archivePath}' '${destination}'`]);
    return;
  }
  run('tar', ['-xf', archivePath, '-C', destination]);
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
