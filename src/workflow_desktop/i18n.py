from __future__ import annotations

SUPPORTED_LANGS = ("en-US", "zh-CN")

LANGUAGE_LABELS = {
    "en-US": "English",
    "zh-CN": "简体中文",
}

EN_TO_ZH: dict[str, str] = {
    "Task Center": "任务中心",
    "Task Detail": "任务详情",
    "Results": "结果",
    "History": "历史",
    "Notifications": "通知",
    "MCP Config": "MCP 配置",
    "Settings": "设置",
    "Workflow Controller Prototype (Desktop)": "工作流控制端原型（桌面）",
    "LAN task dispatch, MCP execution, artifact return and live telemetry": "局域网任务分发、MCP 执行、产物回传与实时遥测",
    "Online Nodes": "在线节点",
    "Create and Dispatch Task": "创建并下发任务",
    "Task Queue and Artifacts": "任务队列与产物",
    "Selected Task Artifacts": "当前任务产物",
    "Quick Operations": "快捷操作",
    "Connect": "连接",
    "Refresh": "刷新",
    "Agent Check": "Agent 检查",
    "Sync Config": "同步配置",
    "Add Files": "添加文件",
    "Add Folder": "添加文件夹",
    "Remove Selected": "移除选中",
    "Clear Paths": "清空路径",
    "Browse": "浏览",
    "Pick .tex": "选择 .tex",
    "Dispatch Echo Task": "下发 Echo 任务",
    "Dispatch LaTeX Task": "下发 LaTeX 任务",
    "Upload Inputs": "上传输入",
    "Open": "打开",
    "Copy Path": "复制路径",
    "Download": "下载",
    "Re-run Selected Task": "重跑选中任务",
    "Export Event Stream (.ndjson)": "导出事件流 (.ndjson)",
    "Retry Failed Batch": "重试失败批次",
    "Apply Runtime": "应用到运行时",
    "Save Settings": "保存设置",
    "Reload Settings": "重载设置",
    "Check Updates": "检查更新",
    "Ready": "就绪",
    "Current Version": "当前版本",
    "Settings path": "设置文件路径",
    "NATS URL": "NATS 地址",
    "Node Candidates": "节点候选",
    "Poll Interval": "轮询间隔",
    "LAN Discovery Enabled": "启用局域网发现",
    "LAN Discovery Port": "局域网发现端口",
    "LAN Discovery Max Age (sec)": "发现有效期（秒）",
    "LAN Auto Switch NATS": "自动切换到局域网 NATS",
    "Language": "语言",
    "Config Sync Enabled": "启用配置同步",
    "Config Sync Interval (sec)": "配置同步间隔（秒）",
    "Config Sync Conflict Policy": "配置冲突策略",
    "Log Level": "日志级别",
    "Log File": "日志文件",
    "MCP Config Path": "MCP 配置路径",
    "Notification Max Items": "通知最大条数",
    "Notification Dedupe Window (sec)": "通知去重窗口（秒）",
    "Notification Auto Mark Read": "通知自动标记已读",
    "Retry Batch Max Limit": "批量重试上限",
    "Retry Batch Interval (sec)": "批量重试间隔（秒）",
    "Retry Batch Skip Kinds": "批量重试跳过类型",
    "Retry Reroute Mode": "失败重试改道模式",
    "Retry Attempts Per Task": "单任务重试次数",
    "Retry Backoff Base (sec)": "重试退避基准（秒）",
    "Update Enabled": "启用更新",
    "Update Feed URL": "更新源 URL",
    "Update Asset Pattern": "更新产物匹配规则",
    "Update Check On Start": "启动时检查更新",
    "Connection status: not connected": "连接状态：未连接",
    "Connection status: Connecting...": "连接状态：连接中...",
    "Connection status: Connected": "连接状态：已连接",
}

ZH_TO_EN = {v: k for k, v in EN_TO_ZH.items()}


def normalize_language(value: str | None) -> str:
    raw = (value or "").strip().lower()
    if raw in {"zh", "zh-cn", "cn", "chinese"}:
        return "zh-CN"
    return "en-US"


def translate_text(text: str, language: str) -> str:
    target = normalize_language(language)
    if target == "zh-CN":
        return EN_TO_ZH.get(text, text)
    return ZH_TO_EN.get(text, text)
