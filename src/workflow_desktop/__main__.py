from __future__ import annotations

import argparse
import os
import sys

from workflow_desktop import run_desktop_app
from workflow_desktop.models import DesktopConfig, default_mcp_config_path, default_settings_path
from workflow_discovery import DISCOVERY_PORT_DEFAULT
from workflow_logging import setup_logging


def _env_flag(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="AgSwarm", description="AgSwarm desktop client")
    parser.add_argument("--nats-url", default=os.getenv("WORKFLOW_NATS_URL", "nats://127.0.0.1:4222"))
    parser.add_argument("--client-id", default=os.getenv("WORKFLOW_DESKTOP_CLIENT_ID", "desktop-client"))
    parser.add_argument("--language", default=os.getenv("WORKFLOW_DESKTOP_LANGUAGE", "en-US"))
    parser.add_argument(
        "--nodes",
        default=os.getenv("WORKFLOW_DESKTOP_NODE_CANDIDATES", "node-a,node-win,node-smoke"),
        help="Comma separated node IDs shown in left panel.",
    )
    parser.add_argument(
        "--poll-interval-sec",
        type=float,
        default=float(os.getenv("WORKFLOW_DESKTOP_POLL_INTERVAL_SEC", "2.0")),
    )
    parser.add_argument(
        "--disable-discovery",
        action="store_true",
        default=not _env_flag("WORKFLOW_DISCOVERY_ENABLED", default=True),
        help="Disable LAN UDP node auto-discovery in desktop client.",
    )
    parser.add_argument(
        "--discovery-port",
        type=int,
        default=int(os.getenv("WORKFLOW_DISCOVERY_PORT", str(DISCOVERY_PORT_DEFAULT))),
    )
    parser.add_argument(
        "--discovery-max-age-sec",
        type=float,
        default=float(os.getenv("WORKFLOW_DISCOVERY_MAX_AGE_SEC", "8.0")),
    )
    parser.add_argument(
        "--disable-auto-switch-nats",
        action="store_true",
        default=not _env_flag("WORKFLOW_DISCOVERY_AUTO_SWITCH_NATS", default=True),
        help="Disable auto switch from loopback NATS URL to discovered LAN NATS URL.",
    )
    parser.add_argument(
        "--disable-config-sync",
        action="store_true",
        default=not _env_flag("WORKFLOW_CONFIG_SYNC_ENABLED", default=True),
        help="Disable desktop->node config sync.",
    )
    parser.add_argument(
        "--config-sync-interval-sec",
        type=float,
        default=float(os.getenv("WORKFLOW_CONFIG_SYNC_INTERVAL_SEC", "30.0")),
    )
    parser.add_argument(
        "--config-sync-conflict-policy",
        default=os.getenv("WORKFLOW_CONFIG_SYNC_CONFLICT_POLICY", "desktop_wins"),
        help="desktop_wins | node_wins | manual",
    )
    parser.add_argument(
        "--mcp-config-path",
        default=os.getenv("WORKFLOW_DESKTOP_MCP_CONFIG_PATH"),
        help="Path for local MCP service config json.",
    )
    parser.add_argument(
        "--settings-path",
        default=os.getenv("WORKFLOW_DESKTOP_SETTINGS_PATH"),
        help="Path for desktop settings json.",
    )
    parser.add_argument(
        "--log-level",
        default=os.getenv("WORKFLOW_LOG_LEVEL", "INFO"),
        help="Log level: DEBUG/INFO/WARN/ERROR",
    )
    parser.add_argument(
        "--log-file",
        default=os.getenv("WORKFLOW_LOG_FILE", "tmp/test-logs/desktop.app.log"),
    )
    return parser


def main() -> int:
    parser = _build_parser()
    args = parser.parse_args()
    setup_logging(level=args.log_level, log_file=args.log_file)

    config = DesktopConfig(
        nats_url=args.nats_url,
        client_id=args.client_id,
        language=str(args.language or "en-US"),
        node_candidates=[x.strip() for x in str(args.nodes).split(",") if x.strip()],
        poll_interval_sec=max(0.5, args.poll_interval_sec),
        discovery_enabled=not bool(args.disable_discovery),
        discovery_port=max(1, int(args.discovery_port)),
        discovery_max_age_sec=max(2.0, float(args.discovery_max_age_sec)),
        discovery_auto_switch_nats=not bool(args.disable_auto_switch_nats),
        config_sync_enabled=not bool(args.disable_config_sync),
        config_sync_interval_sec=max(5.0, float(args.config_sync_interval_sec)),
        config_sync_conflict_policy=str(args.config_sync_conflict_policy or "desktop_wins"),
        mcp_config_path=args.mcp_config_path or default_mcp_config_path(),
        settings_path=args.settings_path or default_settings_path(),
    )
    try:
        return run_desktop_app(config)
    except Exception as exc:
        print(f"AgSwarm failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
