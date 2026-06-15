#!/usr/bin/env node
import { accessSync, constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, '..');
const binariesDir = path.join(desktopDir, 'src-tauri', 'binaries');

const SUPPORTED_TARGETS = [
  { platform: 'darwin', arch: 'arm64', label: 'macOS Apple Silicon', triple: 'aarch64-apple-darwin', exe: '' },
  { platform: 'darwin', arch: 'x64', label: 'macOS Intel', triple: 'x86_64-apple-darwin', exe: '' },
  { platform: 'win32', arch: 'x64', label: 'Windows x64', triple: 'x86_64-pc-windows-msvc', exe: '.exe' },
  { platform: 'linux', arch: 'x64', label: 'Linux x64', triple: 'x86_64-unknown-linux-gnu', exe: '' },
];

const args = new Set(process.argv.slice(2));
const checkAll = args.has('--all');
const current = SUPPORTED_TARGETS.find(target => target.platform === os.platform() && target.arch === os.arch());
const targets = checkAll ? SUPPORTED_TARGETS : current ? [current] : [];

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
console.log(`Sidecar check passed for ${targetLabel}.`);
