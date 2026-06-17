#!/usr/bin/env node
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, '..');
const binariesDir = path.join(desktopDir, 'src-tauri', 'binaries');
const runtimeDir = path.join(binariesDir, 'runtime-node');
const runtimeArchivePath = path.join(binariesDir, 'runtime-node.zip');
const piWebPackageDir = path.join(runtimeDir, 'node_modules', '@jmfederico', 'pi-web');

const SUPPORTED_TARGETS = [
  { platform: 'darwin', arch: 'arm64', label: 'macOS Apple Silicon', triple: 'aarch64-apple-darwin', exe: '' },
  { platform: 'darwin', arch: 'x64', label: 'macOS Intel', triple: 'x86_64-apple-darwin', exe: '' },
  { platform: 'win32', arch: 'x64', label: 'Windows x64', triple: 'x86_64-pc-windows-msvc', exe: '.exe' },
  { platform: 'linux', arch: 'x64', label: 'Linux x64', triple: 'x86_64-unknown-linux-gnu', exe: '' },
];

const args = new Set(process.argv.slice(2));
const targetArg = readArg(process.argv.slice(2), '--target') || process.env.TAURI_SIDECAR_TARGET;
const checkAll = args.has('--all');
const skipRuntime = args.has('--skip-runtime');
const current = SUPPORTED_TARGETS.find(target => target.platform === os.platform() && target.arch === os.arch());
const explicitTarget = targetArg ? SUPPORTED_TARGETS.find(target => target.triple === targetArg) : undefined;
const targets = checkAll ? SUPPORTED_TARGETS : explicitTarget ? [explicitTarget] : current ? [current] : [];

if (!targets.length) {
  console.error(`Unsupported sidecar validation target: ${os.platform()} ${os.arch()}`);
  process.exit(1);
}

const missing = [];

for (const target of targets) {
  for (const baseName of ['node', 'pi-agent-session-bridge']) {
    const fileName = `${baseName}-${target.triple}${target.exe}`;
    const filePath = path.join(binariesDir, fileName);
    try {
      const accessMode = target.platform === 'win32' ? constants.R_OK : constants.R_OK | constants.X_OK;
      accessSync(filePath, accessMode);
    } catch {
      missing.push({ target, fileName, filePath });
    }
  }
  if (!skipRuntime) checkPiWebRuntime(target);
}

if (missing.length) {
  console.error('Missing executable Tauri sidecars:');
  for (const item of missing) {
    console.error(`- ${item.target.label}: ${item.fileName}`);
    console.error(`  expected: ${item.filePath}`);
  }
  console.error('');
  console.error('Build the matching Node runtime and pi AgentSession bridge before packaging this platform.');
  console.error('Do not bypass pi or fall back to a provider/Python bridge to hide this failure.');
  process.exit(1);
}

const targetLabel = checkAll ? 'all configured desktop targets' : targets[0].label;
console.log(`Sidecar check passed for ${targetLabel}${skipRuntime ? ' (runtime skipped)' : ''}.`);

function checkPiWebRuntime(target) {
  for (const filePath of requiredRuntimeFiles(target)) {
    try {
      accessSync(filePath, constants.R_OK);
    } catch {
      missing.push({
        target,
        fileName: path.relative(binariesDir, filePath),
        filePath,
      });
    }
  }
  checkRuntimeArchiveIsZip(target);
}

function checkRuntimeArchiveIsZip(target) {
  try {
    const metadata = statSync(runtimeArchivePath);
    if (metadata.size < 22) {
      throw new Error(`archive is too small (${metadata.size} bytes)`);
    }
    const tailLength = Math.min(metadata.size, 66_000);
    const file = readFileSync(runtimeArchivePath);
    const tail = file.subarray(file.length - tailLength);
    const eocdSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
    if (tail.lastIndexOf(eocdSignature) === -1) {
      throw new Error('archive is missing ZIP end-of-central-directory signature');
    }
    if (file.subarray(0, 2).toString('binary') !== 'PK') {
      throw new Error('archive does not start with a ZIP local/header signature');
    }
  } catch (error) {
    missing.push({
      target,
      fileName: 'runtime-node.zip',
      filePath: `${runtimeArchivePath} (${error instanceof Error ? error.message : String(error)})`,
    });
  }
}

function requiredRuntimeFiles(target) {
  const files = [
    path.join(runtimeDir, 'package.json'),
    path.join(runtimeDir, 'package-lock.json'),
    path.join(runtimeDir, '.agswarm-runtime-target'),
    runtimeArchivePath,
    path.join(piWebPackageDir, 'package.json'),
    path.join(piWebPackageDir, 'dist', 'server', 'index.js'),
    path.join(piWebPackageDir, 'dist', 'server', 'sessiond.js'),
    path.join(piWebPackageDir, 'dist', 'server', 'app.js'),
    path.join(piWebPackageDir, 'dist', 'config.js'),
    path.join(piWebPackageDir, 'dist', 'client', 'index.html'),
    path.join(piWebPackageDir, 'dist', 'pi-web-plugins', 'info', 'pi-web-plugin.js'),
    path.join(binariesDir, 'pi-web-agswarm-server.mjs'),
    path.join(binariesDir, 'pi-web-client', 'index.html'),
    path.join(binariesDir, 'pi-web-plugins', 'agswarm-theme', 'pi-web-plugin.js'),
    path.join(binariesDir, 'pi-web-package', 'dist', 'server', 'index.js'),
    path.join(binariesDir, 'pi-web-package', 'dist', 'server', 'sessiond.js'),
  ];
  if (target.platform === 'win32') {
    files.push(
      path.join(runtimeDir, 'node_modules', 'node-pty', 'prebuilds', 'win32-x64', 'pty.node'),
      path.join(runtimeDir, 'node_modules', 'node-pty', 'prebuilds', 'win32-x64', 'conpty.node'),
      path.join(runtimeDir, 'node_modules', 'node-pty', 'prebuilds', 'win32-x64', 'conpty_console_list.node'),
      path.join(runtimeDir, 'node_modules', 'node-pty', 'prebuilds', 'win32-x64', 'winpty.dll'),
      path.join(runtimeDir, 'node_modules', 'node-pty', 'prebuilds', 'win32-x64', 'winpty-agent.exe'),
    );
  }
  return files;
}

function readArg(values, name) {
  const index = values.indexOf(name);
  if (index === -1) return '';
  const value = values[index + 1];
  return value && !value.startsWith('--') ? value : '';
}
