#!/usr/bin/env node

const baseUrl = process.env.AGSWARM_PI_WEB_URL || 'http://127.0.0.1:8504';
const cwd = process.env.AGSWARM_STRESS_CWD || process.cwd().replace(/\/desktop$/, '');
const iterations = Number(process.env.AGSWARM_STRESS_ITERATIONS || '12');

const checks = [
  ['runtime', () => request('/api/machines/local/runtime')],
  ['sessions-options', () => request(`/api/machines/local/sessions?cwd=${encodeURIComponent(cwd)}`, { method: 'OPTIONS' }, 204)],
  ['sessions', () => request(`/api/machines/local/sessions?cwd=${encodeURIComponent(cwd)}`)],
];

const started = Date.now();
const failures = [];

for (let index = 0; index < iterations; index += 1) {
  for (const [name, run] of checks) {
    try {
      await run();
    } catch (error) {
      failures.push({ iteration: index + 1, check: name, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const sessions = await request(`/api/machines/local/sessions?cwd=${encodeURIComponent(cwd)}`);
  const firstSession = Array.isArray(sessions.body) ? sessions.body[0] : undefined;
  if (firstSession?.id) {
    for (const suffix of ['messages', 'status', 'commands']) {
      try {
        await request(`/api/machines/local/sessions/${encodeURIComponent(firstSession.id)}/${suffix}?cwd=${encodeURIComponent(cwd)}`);
      } catch (error) {
        failures.push({ iteration: index + 1, check: suffix, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
}

const elapsedMs = Date.now() - started;
if (failures.length) {
  console.error(JSON.stringify({ ok: false, baseUrl, cwd, iterations, elapsedMs, failures }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, baseUrl, cwd, iterations, elapsedMs }, null, 2));

async function request(path, init = {}, expectedStatus = 200) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      accept: 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  let body;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (response.status !== expectedStatus) {
    throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 240)}`);
  }
  return { response, body };
}
