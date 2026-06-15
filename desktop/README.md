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
npm run check:sidecars
npm run tauri:build
```

macOS bundles are emitted under `src-tauri/target/release/bundle/`.

`tauri:build` runs `check:sidecars` before Vite/Tauri packaging. The packaged
Ag runtime must use the bundled pi AgentSession bridge and Node runtime; missing
sidecars are build failures rather than provider/Python fallbacks.

## Platform Sidecars

GitHub Actions prepares the desktop sidecars automatically for each release
matrix target before running Tauri. For local packaging, prepare the current
machine first:

```bash
npm run prepare:sidecars -- --force
npm run check:sidecars
```

Current desktop targets expect these executable files under
`src-tauri/binaries/`:

- `node-aarch64-apple-darwin`
- `pi-agent-session-bridge-aarch64-apple-darwin`
- `node-x86_64-apple-darwin`
- `pi-agent-session-bridge-x86_64-apple-darwin`
- `node-x86_64-pc-windows-msvc.exe`
- `pi-agent-session-bridge-x86_64-pc-windows-msvc.exe`
- `node-x86_64-unknown-linux-gnu`
- `pi-agent-session-bridge-x86_64-unknown-linux-gnu`

Check the current machine only:

```bash
npm run check:sidecars
```

Check all configured desktop targets before release work:

```bash
npm run check:sidecars:all
```

Mobile support is currently the responsive web/Tauri WebView surface. Native
iOS/Android packaging still needs a separate runtime plan because the desktop
sidecar model cannot be copied directly into mobile sandbox rules.
