# AgSwarm Client

Tauri + React desktop client for AgSwarm.

## Development

```bash
npm install
npm run lint
npm run build
npm run tauri:dev
```

The default local agent provider is OpenAI-compatible HTTP:

```bash
VITE_AGENT_PROVIDER_URL=http://127.0.0.1:15721
VITE_AGENT_MODEL=gpt-5.5
VITE_AGENT_API_KEY=local-dev-key
```

## Build

```bash
npm run tauri:build
```

macOS bundles are emitted under `src-tauri/target/release/bundle/`.
