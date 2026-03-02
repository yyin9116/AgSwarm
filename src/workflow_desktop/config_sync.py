from __future__ import annotations

CONFLICT_POLICY_DESKTOP_WINS = "desktop_wins"
CONFLICT_POLICY_NODE_WINS = "node_wins"
CONFLICT_POLICY_MANUAL = "manual"

CONFLICT_POLICY_OPTIONS = (
    CONFLICT_POLICY_DESKTOP_WINS,
    CONFLICT_POLICY_NODE_WINS,
    CONFLICT_POLICY_MANUAL,
)


def decide_sync_action(*, policy: str, local_digest: str, remote_digest: str, force: bool = False) -> str:
    if force:
        return "push"
    if not local_digest:
        return "skip"
    if remote_digest and remote_digest == local_digest:
        return "skip_same"
    if remote_digest and remote_digest != local_digest:
        normalized = str(policy or CONFLICT_POLICY_DESKTOP_WINS).strip().lower()
        if normalized == CONFLICT_POLICY_NODE_WINS:
            return "skip_node_wins"
        if normalized == CONFLICT_POLICY_MANUAL:
            return "skip_manual"
    return "push"
