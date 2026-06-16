import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import type { ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'path';
import { promisify } from 'node:util';
import type { Connect } from 'vite';
import {defineConfig, loadEnv} from 'vite';

const execFileAsync = promisify(execFile);
const TOOL_OUTPUT_LIMIT = 24_000;
const TOOL_TIMEOUT_MS = 30_000;

function providerProxy(mode: string) {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    '/api/machines/local': {
      target: env.VITE_PI_WEB_URL || 'http://127.0.0.1:8504',
      changeOrigin: true,
      ws: true,
    },
    '/__agswarm_provider': {
      target: env.VITE_AGENT_PROVIDER_URL || 'http://127.0.0.1:15721',
      changeOrigin: true,
      configure: proxy => {
        proxy.on('proxyReq', proxyReq => {
          proxyReq.setHeader('accept-encoding', 'identity');
        });
      },
      rewrite: (requestPath: string) => requestPath.replace(/^\/__agswarm_provider/, ''),
    },
  };
}

function desktopAgentToolPlugin() {
  return {
    name: 'agswarm-desktop-agent-tool',
    configureServer(server: { middlewares: Connect.Server }) {
      server.middlewares.use('/__agswarm_desktop_tool', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { message: 'method not allowed' });
          return;
        }
        try {
          const request = await readJsonBody(req);
          const result = await runDesktopTool(request);
          sendJson(res, result.ok ? 200 : 500, result);
        } catch (error) {
          sendJson(res, 400, { message: error instanceof Error ? error.message : String(error) });
        }
      });
    },
  };
}

function readJsonBody(req: Connect.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 256_000) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

async function runDesktopTool(request) {
  const startedAt = Date.now();
  const tool = normalizeToolName(request?.tool);
  const cwd = resolveToolCwd(request?.workspaceRoot, request?.cwd);
  const timeoutMs = normalizeTimeout(request?.timeoutMs);

  if (tool === 'workspace_info') {
    return {
      ok: true,
      tool,
      cwd,
      stdout: JSON.stringify({
        cwd,
        homeDir: os.homedir(),
        platform: process.platform,
        node: process.version,
        files: fs.readdirSync(cwd).slice(0, 80),
      }, null, 2),
      stderr: '',
      durationMs: Date.now() - startedAt,
      meta: { readOnly: true },
    };
  }

  const command = tool === 'python'
    ? await writeTempPythonScript(String(request?.script || ''))
    : String(request?.command || '').trim();
  if (!command) throw new Error(`${tool} request is missing command text`);
  assertAllowedCommand(tool, command);

  const argv = tool === 'python'
    ? ['python3', command]
    : ['/bin/zsh', '-lc', command];
  try {
    const output = await execFileAsync(argv[0], argv.slice(1), {
      cwd,
      timeout: timeoutMs,
      maxBuffer: TOOL_OUTPUT_LIMIT * 2,
      env: { ...process.env, PATH: childPathEnv() },
    });
    return toolResult({ tool, cwd, command: tool === 'python' ? 'python3 <generated script>' : command, output, startedAt });
  } catch (error) {
    return toolResult({
      tool,
      cwd,
      command: tool === 'python' ? 'python3 <generated script>' : command,
      output: error,
      startedAt,
      ok: false,
    });
  }
}

function normalizeToolName(value) {
  if (value === 'workspace_info' || value === 'shell' || value === 'python') return value;
  throw new Error('unsupported desktop agent tool');
}

function normalizeTimeout(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return TOOL_TIMEOUT_MS;
  return Math.max(500, Math.min(numeric, 120_000));
}

function resolveToolCwd(workspaceRoot, value) {
  const root = process.cwd();
  const requestedRoot = String(workspaceRoot || '').trim();
  const base = requestedRoot
    ? path.resolve(root, requestedRoot)
    : root;
  if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) {
    throw new Error(`configured host working directory does not exist: ${base}`);
  }
  const requested = String(value || '').trim();
  if (!requested) return base;
  const resolved = path.resolve(base, requested);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    throw new Error('cwd must stay inside the configured host working directory');
  }
  return resolved;
}

async function writeTempPythonScript(script) {
  if (!script.trim()) throw new Error('python script is required');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agswarm-agent-'));
  const file = path.join(dir, 'tool.py');
  fs.writeFileSync(file, `${script.trim()}\n`, 'utf8');
  return file;
}

function assertAllowedCommand(tool, command) {
  const lower = command.toLowerCase();
  const blocked = [
    'rm -rf /',
    'sudo ',
    'mkfs',
    'diskutil erase',
    'dd if=',
    ':(){',
    'chmod -r 777 /',
  ];
  if (tool === 'shell' && blocked.some(pattern => lower.includes(pattern))) {
    throw new Error('command blocked by desktop agent safety policy');
  }
}

function toolResult({
  tool,
  cwd,
  command,
  output,
  startedAt,
  ok,
}: {
  tool: string;
  cwd: string;
  command: string;
  output: any;
  startedAt: number;
  ok?: boolean;
}) {
  const exitCode = typeof output?.code === 'number' ? output.code : ok === false ? 1 : 0;
  const stdout = limitOutput(String(output?.stdout || ''));
  const stderr = limitOutput(String(output?.stderr || output?.message || ''));
  return {
    ok: ok ?? exitCode === 0,
    tool,
    cwd,
    command,
    stdout: stdout.text,
    stderr: stderr.text,
    exitCode,
    timedOut: Boolean(output?.killed && output?.signal === 'SIGTERM'),
    truncated: stdout.truncated || stderr.truncated,
    durationMs: Date.now() - startedAt,
  };
}

function limitOutput(text) {
  if (text.length <= TOOL_OUTPUT_LIMIT) return { text, truncated: false };
  return { text: `${text.slice(0, TOOL_OUTPUT_LIMIT)}\n...[truncated]`, truncated: true };
}

function childPathEnv() {
  const paths = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    ...(process.env.PATH || '').split(':'),
  ].filter(Boolean);
  return [...new Set(paths)].join(':');
}

function sendJson(res: ServerResponse, status: number, payload: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

export default defineConfig(({ mode }) => {
  const proxy = providerProxy(mode);
  return {
    base: './',
    plugins: [react(), tailwindcss(), desktopAgentToolPlugin()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
      proxy,
    },
    preview: {
      proxy,
    },
  };
});
