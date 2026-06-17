#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from 'node:url';

const runtimeRoot = process.env.PI_WEB_RUNTIME_DIR
  ? pathToFileURL(`${process.env.PI_WEB_RUNTIME_DIR}/`)
  : new URL('./runtime-node/', import.meta.url);
const piWebRoot = new URL('node_modules/@jmfederico/pi-web/', runtimeRoot);
const { buildApp } = await import(new URL('dist/server/app.js', piWebRoot));
const { effectivePiWebConfig } = await import(new URL('dist/config.js', piWebRoot));
const { PiWebPluginService } = await import(new URL('dist/server/piWebPluginService.js', piWebRoot));

const app = await buildApp({
  clientDist: fileURLToPath(new URL('./pi-web-client/', import.meta.url)),
  piWebPlugins: new PiWebPluginService({
    roots: [
      {
        path: fileURLToPath(new URL('dist/pi-web-plugins/', piWebRoot)),
        source: 'bundled',
        scope: 'bundled',
      },
      {
        path: fileURLToPath(new URL('./pi-web-plugins/', import.meta.url)),
        source: 'agswarm',
        scope: 'local',
      },
    ],
  }),
});
app.addHook('onRequest', async (request, reply) => {
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  reply.header('Access-Control-Allow-Headers', 'content-type,accept');
  if (request.method === 'OPTIONS') {
    return reply.code(204).send();
  }
});
const { config } = effectivePiWebConfig();
await app.listen({ port: config.port ?? 8504, host: config.host ?? '127.0.0.1' });
