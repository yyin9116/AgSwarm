const lightTokens = {
  "--pi-bg": "#f8fafc",
  "--pi-surface": "#ffffff",
  "--pi-surface-hover": "#f1f5f9",
  "--pi-terminal-bg": "#0f172a",
  "--pi-terminal-text": "#e2e8f0",
  "--pi-border": "#dbe3ea",
  "--pi-border-muted": "#e8eef4",
  "--pi-text": "#172033",
  "--pi-text-secondary": "#334155",
  "--pi-text-bright": "#0f172a",
  "--pi-muted": "#64748b",
  "--pi-dim": "#94a3b8",
  "--pi-accent": "#0f766e",
  "--pi-accent-border": "#0d9488",
  "--pi-selection-bg": "#ccfbf1",
  "--pi-success": "#15803d",
  "--pi-success-border": "#22c55e",
  "--pi-success-bg": "#f0fdf4",
  "--pi-success-surface": "#dcfce7",
  "--pi-success-ring": "#22c55e55",
  "--pi-warning": "#b45309",
  "--pi-warning-border": "#f59e0b",
  "--pi-warning-surface": "#fffbeb",
  "--pi-danger": "#dc2626",
  "--pi-purple": "#7c3aed",
  "--pi-purple-border": "#8b5cf6",
  "--pi-purple-surface": "#f5f3ff",
  "--pi-overlay": "#0f172a33",
  "--pi-shadow-soft": "#0f172a14",
  "--pi-shadow": "#0f172a1f",
  "--pi-shadow-strong": "#0f172a2e",
  "--pi-bg-overlay-soft": "#f8fafcdd",
  "--pi-bg-overlay": "#ffffffe6",
  "--pi-success-bg-overlay": "#f0fdf4ee",
  "--pi-terminal-selection": "#334155"
};

const plugin = {
  apiVersion: 1,
  name: "AgSwarm Theme",
  activate: () => ({
    contributions: {
      themes: [
        {
          id: "light",
          name: "AgSwarm Light",
          description: "White desktop theme aligned with AgSwarm Client.",
          order: -100,
          colorScheme: "light",
          tokens: lightTokens
        }
      ]
    }
  })
};

export default plugin;
