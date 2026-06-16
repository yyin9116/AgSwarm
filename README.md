<h1>
  <img src="assets/icons/app-icon.png" width="32" alt="AgSwarm icon">
  AgSwarm
</h1>

AgSwarm is a cross-platform desktop client for coordinating local AI agents, devices, tasks, and workspace-aware automation.

The desktop app brings chat, command execution, device discovery, task handoff, and settings into one local-first workspace. The current app experience centers on **Ag**, the built-in AI assistant backed by the pi agent runtime, so agent replies, tools, workspace context, and device/task workflows stay inside the AgSwarm control surface instead of bypassing the app.

## What It Does

- **Chat and command with Ag** in the current workspace.
- **Coordinate nearby devices** discovered through the AgSwarm control plane.
- **Track tasks** that can be dispatched to capable local peers.
- **Configure identity and workspace settings** from the desktop UI.
- **Package the pi-backed agent runtime with the app** through Tauri sidecars, so release builds fail fast if the required agent bridge or Node runtime is missing.

## Download

The latest packaged desktop build is published on GitHub Releases:

[Download AgSwarm v0.2.13](https://github.com/yyin9116/AgSwarm/releases/tag/v0.2.13)

Current release artifacts:

| Platform | Artifact |
| --- | --- |
| macOS Apple Silicon | `.dmg` and `.app.zip` |
| Windows x64 | `.exe` and `.msi` |
| Checksums | `SHA256SUMS.txt` |

Intel macOS and Linux installers are not part of the current public release matrix.

## Main Workflows

### Chat / Command

Open the Copilot tab to work with Ag in the selected workspace. Ag is intended to answer with workspace context, show agent activity, and use the app runtime rather than directly calling a provider from the frontend.

### Devices

Use the Devices page to refresh and inspect peers that are visible on the current AgSwarm control plane. Device names and user-facing identity are app settings, not hard-coded local machine labels.

### Tasks

Use Tasks to review work items and device-directed operations. The project is moving toward multi-client agent collaboration where capable peers can join the same workflow.

### Settings

Use Settings for local profile, workspace, and runtime configuration. The app should surface connection/runtime errors as product errors rather than raw stack traces.

## Development

Desktop development lives under `desktop/`.

```bash
cd desktop
npm install
npm run lint
npm run build
npm run tauri:dev
```

Useful scripts:

| Command | Purpose |
| --- | --- |
| `npm run lint` | Type-check the desktop frontend. |
| `npm run build` | Build the Vite frontend. |
| `npm run tauri:dev` | Run the Tauri desktop app in development mode. |
| `npm run tauri:build` | Build a local Tauri bundle after sidecar checks. |
| `npm run prepare:sidecars -- --force` | Prepare local Tauri sidecars for packaging. |
| `npm run check:sidecars` | Verify required sidecars for the current target. |

The desktop package uses Tauri, React, Mantine, CopilotKit integration surfaces, and pi/pi-web runtime packages. See [desktop/README.md](desktop/README.md) for sidecar details and local packaging notes.

## Release Automation

Desktop release packaging is defined in [.github/workflows/desktop-build-release.yml](.github/workflows/desktop-build-release.yml).

- Pull requests and pushes that touch desktop release inputs run desktop CI.
- Version tags matching `v*` build release artifacts.
- The current release matrix builds macOS Apple Silicon and Windows x64.
- Release notes come from `docs/releases/<tag>.md` when present, for example [docs/releases/v0.2.13.md](docs/releases/v0.2.13.md).
- Release assets include generated checksums in `SHA256SUMS.txt`.

The workflow prepares Node and pi AgentSession bridge sidecars before packaging. Missing sidecars are treated as build failures instead of falling back to a provider bypass or a Python bridge.

## Documentation

- [Desktop client development](docs/desktop-client-dev.md)
- [NATS local development quickstart](docs/nats-dev-quickstart.md)
- [Skills configuration](docs/skills-config.md)
- [Project structure](docs/project-structure.md)
- [Mainline roadmap](docs/mainline-roadmap.md)

## Status

AgSwarm is under active development. The current public desktop release is `v0.2.13`; platform claims, screenshots, and release notes should be kept aligned with actual GitHub Release artifacts.
