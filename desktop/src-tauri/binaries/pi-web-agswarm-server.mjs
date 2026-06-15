#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { buildApp } from './runtime-node/node_modules/@jmfederico/pi-web/dist/server/app.js';
import { effectivePiWebConfig } from './runtime-node/node_modules/@jmfederico/pi-web/dist/config.js';
import { PiWebPluginService } from './runtime-node/node_modules/@jmfederico/pi-web/dist/server/piWebPluginService.js';

const app = await buildApp({
  clientDist: fileURLToPath(new URL('./pi-web-client/', import.meta.url)),
  piWebPlugins: new PiWebPluginService({
    roots: [
      {
        path: fileURLToPath(new URL('./runtime-node/node_modules/@jmfederico/pi-web/dist/pi-web-plugins/', import.meta.url)),
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
