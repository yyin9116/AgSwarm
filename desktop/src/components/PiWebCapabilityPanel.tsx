import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Modal,
  PasswordInput,
  ScrollArea,
  Select,
  Stack,
  Tabs,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import {
  Check,
  ChevronRight,
  FileSearch,
  FileText,
  GitBranch,
  KeyRound,
  ListTree,
  LogOut,
  Play,
  RefreshCw,
  Square,
  TerminalSquare,
  Wrench,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  cancelPiWebOAuth,
  cancelPiWebTerminalCommandRun,
  getPiWebFileTree,
  getPiWebGitDiff,
  getPiWebGitStatus,
  getPiWebOAuthFlow,
  getPiWebTerminalCommandRun,
  listPiWebAuthProviders,
  listPiWebFileSuggestions,
  logoutPiWebProvider,
  readPiWebFile,
  respondPiWebOAuth,
  respondToPiWebCommand,
  runPiWebTerminalCommand,
  savePiWebApiKey,
  sendPiWebShellInput,
  setPiWebModel,
  setPiWebThinkingLevel,
  startPiWebOAuth,
  type PiWebAuthProviderOption,
  type PiWebCommandResult,
  type PiWebFileSuggestion,
  type PiWebFileTreeEntry,
  type PiWebFileTreeResponse,
  type PiWebGitStatusResponse,
  type PiWebOAuthFlowState,
  type PiWebSessionInfo,
  type PiWebSessionModel,
  type PiWebSessionStatus,
  type PiWebTerminalCommandRun,
  type PiWebThinkingLevel,
  type PiWebWorkspaceContext,
} from '../lib/piWebClient';

type PendingCommandSelect = Extract<PiWebCommandResult, { type: 'select' }>;

type PiWebCapabilityPanelProps = {
  session: PiWebSessionInfo | undefined;
  cwd: string;
  status: PiWebSessionStatus | null;
  models: PiWebSessionModel[];
  thinkingLevels: PiWebThinkingLevel[];
  workspaceContext: PiWebWorkspaceContext | null;
  pendingCommandSelect: PendingCommandSelect | null;
  onPendingCommandSelectChange: (value: PendingCommandSelect | null) => void;
  onStatusChange: (status: PiWebSessionStatus | null) => void;
  onActivity: (label: string, detail?: string, tone?: 'neutral' | 'error') => void;
  onCommandResult: (result: PiWebCommandResult) => void;
  onError: (message: string) => void;
};

export function PiWebCapabilityPanel({
  session,
  cwd,
  status,
  models,
  thinkingLevels,
  workspaceContext,
  pendingCommandSelect,
  onPendingCommandSelectChange,
  onStatusChange,
  onActivity,
  onCommandResult,
  onError,
}: PiWebCapabilityPanelProps) {
  const [isBusy, setIsBusy] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [authProviders, setAuthProviders] = useState<PiWebAuthProviderOption[]>([]);
  const [authLoading, setAuthLoading] = useState(false);
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [oauthFlow, setOauthFlow] = useState<PiWebOAuthFlowState | null>(null);
  const [oauthResponse, setOauthResponse] = useState('');
  const [treePath, setTreePath] = useState('');
  const [fileTree, setFileTree] = useState<PiWebFileTreeResponse | null>(null);
  const [fileQuery, setFileQuery] = useState('');
  const [fileSuggestions, setFileSuggestions] = useState<PiWebFileSuggestion[]>([]);
  const [filePreview, setFilePreview] = useState<{ path: string; content: string } | null>(null);
  const [gitStatus, setGitStatus] = useState<PiWebGitStatusResponse | null>(null);
  const [gitDiffPath, setGitDiffPath] = useState('');
  const [gitDiff, setGitDiff] = useState('');
  const [terminalCommand, setTerminalCommand] = useState('');
  const [terminalRun, setTerminalRun] = useState<PiWebTerminalCommandRun | null>(null);
  const [shellText, setShellText] = useState('');

  const modelValue = status?.model?.provider && status.model.id ? `${status.model.provider}/${status.model.id}` : '';
  const modelOptions = useMemo(() => models.flatMap(model => {
    const provider = model.provider || '';
    const id = model.id || model.name || '';
    return provider && id ? [{ value: `${provider}/${id}`, label: `${model.name || id} · ${provider}` }] : [];
  }), [models]);

  const runPanelAction = useCallback(async (label: string, action: () => Promise<string | void>) => {
    setIsBusy(true);
    try {
      const detail = await action();
      onActivity(label, detail || undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onError(message);
      onActivity(`${label} failed`, friendlyPanelError(message), 'error');
    } finally {
      setIsBusy(false);
    }
  }, [onActivity, onError]);

  const refreshAuthProviders = useCallback(async () => {
    setAuthLoading(true);
    try {
      const providers = await listPiWebAuthProviders('login');
      setAuthProviders(providers);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setAuthLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    if (!authOpen) return;
    void refreshAuthProviders();
  }, [authOpen, refreshAuthProviders]);

  const pollOAuth = useCallback(async (flowId: string) => {
    let next = await getPiWebOAuthFlow(flowId);
    setOauthFlow(next);
    for (let index = 0; index < 40 && next.status === 'running' && !next.prompt && !next.select; index += 1) {
      await delay(750);
      next = await getPiWebOAuthFlow(flowId);
      setOauthFlow(next);
    }
    return next;
  }, []);

  const refreshFileTree = useCallback((path = treePath) => {
    if (!workspaceContext) return;
    void runPanelAction('Workspace files loaded', async () => {
      const tree = await getPiWebFileTree(workspaceContext, path);
      setTreePath(tree.path);
      setFileTree(tree);
      return tree.truncated ? 'Tree truncated.' : `${tree.entries.length} entries`;
    });
  }, [runPanelAction, treePath, workspaceContext]);

  const readFile = useCallback((path: string) => {
    if (!workspaceContext) return;
    void runPanelAction(`Read ${path}`, async () => {
      const file = await readPiWebFile(workspaceContext, path);
      const content = file.binary ? 'Binary file preview is unavailable here.' : truncateText(file.content, 2_500);
      setFilePreview({ path, content });
      return file.truncated ? 'Preview truncated.' : undefined;
    });
  }, [runPanelAction, workspaceContext]);

  const refreshGitStatus = useCallback(() => {
    if (!workspaceContext) return;
    void runPanelAction('Git status loaded', async () => {
      const git = await getPiWebGitStatus(workspaceContext);
      setGitStatus(git);
      if (!git.isGitRepo) return 'This workspace is not a git repository.';
      return `${git.branch || git.hash.slice(0, 8)} · ${git.files.length} changed`;
    });
  }, [runPanelAction, workspaceContext]);

  const pollTerminalRun = useCallback(async (runId: string) => {
    let current = await getPiWebTerminalCommandRun(runId);
    setTerminalRun(current);
    while ((current.status === 'queued' || current.status === 'running')) {
      await delay(600);
      current = await getPiWebTerminalCommandRun(runId);
      setTerminalRun(current);
    }
    return current;
  }, []);

  const commandSelectOptions = pendingCommandSelect?.options || [];

  return (
    <section className="pi-gui-tools-panel" aria-label="Pi Web native controls">
      <Tabs defaultValue="session" className="pi-gui-capability-tabs" keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="session" leftSection={<Wrench size={14} />}>Session</Tabs.Tab>
          <Tabs.Tab value="auth" leftSection={<KeyRound size={14} />}>Auth</Tabs.Tab>
          <Tabs.Tab value="files" leftSection={<ListTree size={14} />}>Files</Tabs.Tab>
          <Tabs.Tab value="git" leftSection={<GitBranch size={14} />}>Git</Tabs.Tab>
          <Tabs.Tab value="terminal" leftSection={<TerminalSquare size={14} />}>Terminal</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="session">
          <div className="pi-gui-capability-grid">
            <Select
              label="Model"
              size="xs"
              value={modelValue}
              data={modelOptions}
              placeholder="Current model"
              disabled={!session || isBusy}
              onChange={(value) => {
                if (!session || !value) return;
                const [provider, ...modelParts] = value.split('/');
                const modelId = modelParts.join('/');
                if (!provider || !modelId) return;
                void runPanelAction(`Model set to ${modelId}`, async () => {
                  const nextStatus = await setPiWebModel(session, provider, modelId);
                  onStatusChange(nextStatus);
                  return provider;
                });
              }}
            />
            <Select
              label="Thinking"
              size="xs"
              value={status?.thinkingLevel || ''}
              data={thinkingLevels.map(level => ({ value: level, label: level }))}
              placeholder="Current level"
              disabled={!session || isBusy}
              onChange={(value) => {
                if (!session || !value) return;
                void runPanelAction(`Thinking set to ${value}`, async () => {
                  const nextStatus = await setPiWebThinkingLevel(session, value as PiWebThinkingLevel);
                  onStatusChange(nextStatus);
                });
              }}
            />
            <div className="pi-gui-tool-inline">
              <Wrench size={14} />
              <input value={shellText} placeholder="Send shell input to active session..." onChange={(event) => setShellText(event.currentTarget.value)} onKeyDown={(event) => {
                if (event.key === 'Enter' && session && shellText.trim()) {
                  const text = shellText;
                  setShellText('');
                  void runPanelAction('Shell input sent', async () => {
                    await sendPiWebShellInput(session, text);
                    return text.trim();
                  });
                }
              }} />
              <button type="button" disabled={!session || !shellText.trim() || isBusy} onClick={() => {
                if (!session) return;
                const text = shellText;
                setShellText('');
                void runPanelAction('Shell input sent', async () => {
                  await sendPiWebShellInput(session, text);
                  return text.trim();
                });
              }}>
                Send
              </button>
            </div>
            {pendingCommandSelect ? (
              <div className="pi-gui-command-select">
                <span>{pendingCommandSelect.title}</span>
                {commandSelectOptions.map(option => (
                  <button key={option.value} type="button" disabled={!session || isBusy} onClick={() => {
                    if (!session || !pendingCommandSelect) return;
                    const requestId = pendingCommandSelect.requestId;
                    onPendingCommandSelectChange(null);
                    void runPanelAction('Command response sent', async () => {
                      const result = await respondToPiWebCommand(session, requestId, option.value);
                      onCommandResult(result);
                    });
                  }}>
                    {option.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </Tabs.Panel>

        <Tabs.Panel value="auth">
          <div className="pi-gui-capability-row">
            <Button size="xs" color="teal" variant="light" leftSection={<KeyRound size={14} />} onClick={() => setAuthOpen(true)}>
              Open auth dialog
            </Button>
            <Text size="xs" c="dimmed">Manage pi-web provider login and API keys.</Text>
          </div>
        </Tabs.Panel>

        <Tabs.Panel value="files">
          <div className="pi-gui-capability-grid">
            <div className="pi-gui-tool-inline">
              <ListTree size={14} />
              <input value={treePath} placeholder="Tree path..." onChange={(event) => setTreePath(event.currentTarget.value)} onKeyDown={(event) => {
                if (event.key === 'Enter') refreshFileTree();
              }} />
              <button type="button" disabled={!workspaceContext || isBusy} onClick={() => refreshFileTree()}>
                Load
              </button>
            </div>
            <div className="pi-gui-tool-inline">
              <FileSearch size={14} />
              <input value={fileQuery} placeholder="Search files..." onChange={(event) => setFileQuery(event.currentTarget.value)} onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  void runPanelAction('File suggestions loaded', async () => {
                    const suggestions = await listPiWebFileSuggestions(cwd, fileQuery, { scope: 'all' });
                    setFileSuggestions(suggestions);
                    return `${suggestions.length} matches`;
                  });
                }
              }} />
              <button type="button" disabled={!fileQuery.trim() || isBusy} onClick={() => {
                void runPanelAction('File suggestions loaded', async () => {
                  const suggestions = await listPiWebFileSuggestions(cwd, fileQuery, { scope: 'all' });
                  setFileSuggestions(suggestions);
                  return `${suggestions.length} matches`;
                });
              }}>
                Search
              </button>
            </div>
            <div className="pi-gui-capability-list">
              {(fileTree?.entries || []).slice(0, 12).map(entry => (
                <FileTreeButton key={`${entry.type}:${entry.path}`} entry={entry} onOpenDirectory={refreshFileTree} onReadFile={readFile} />
              ))}
              {fileSuggestions.slice(0, 8).map(suggestion => (
                <button key={`${suggestion.kind}:${suggestion.path}`} type="button" onClick={() => readFile(suggestion.path)}>
                  <FileText size={13} />
                  <span>{suggestion.path}</span>
                  <Badge size="xs" variant="light">{suggestion.kind}</Badge>
                </button>
              ))}
            </div>
            {filePreview ? (
              <pre className="pi-gui-capability-preview">{filePreview.path}{'\n\n'}{filePreview.content}</pre>
            ) : null}
          </div>
        </Tabs.Panel>

        <Tabs.Panel value="git">
          <div className="pi-gui-capability-grid">
            <div className="pi-gui-capability-row">
              <Button size="xs" variant="light" color="teal" leftSection={<RefreshCw size={14} />} disabled={!workspaceContext || isBusy} onClick={refreshGitStatus}>
                Refresh git
              </Button>
              {gitStatus?.isGitRepo ? <Badge variant="light">{gitStatus.branch || gitStatus.hash.slice(0, 8)}</Badge> : null}
            </div>
            <div className="pi-gui-capability-list">
              {gitStatus?.files.slice(0, 10).map(file => (
                <button key={`${file.path}:${file.index}:${file.workingTree}`} type="button" onClick={() => {
                  setGitDiffPath(file.path);
                  if (!workspaceContext) return;
                  void runPanelAction(`Diff ${file.path}`, async () => {
                    const diff = await getPiWebGitDiff(workspaceContext, file.path);
                    setGitDiff(diff.diff || 'No diff available.');
                    return diff.truncated ? 'Diff truncated.' : undefined;
                  });
                }}>
                  <GitBranch size={13} />
                  <span>{file.path}</span>
                  <Badge size="xs" variant="light">{file.workingTree}</Badge>
                </button>
              ))}
            </div>
            <div className="pi-gui-tool-inline">
              <GitBranch size={14} />
              <input value={gitDiffPath} placeholder="Diff path..." onChange={(event) => setGitDiffPath(event.currentTarget.value)} />
              <button type="button" disabled={!workspaceContext || isBusy} onClick={() => {
                if (!workspaceContext) return;
                void runPanelAction(gitDiffPath ? `Diff ${gitDiffPath}` : 'Workspace diff', async () => {
                  const diff = await getPiWebGitDiff(workspaceContext, gitDiffPath || undefined);
                  setGitDiff(diff.diff || 'No diff available.');
                  return diff.truncated ? 'Diff truncated.' : undefined;
                });
              }}>
                Diff
              </button>
            </div>
            {gitDiff ? <pre className="pi-gui-capability-preview">{gitDiff}</pre> : null}
          </div>
        </Tabs.Panel>

        <Tabs.Panel value="terminal">
          <div className="pi-gui-capability-grid">
            <div className="pi-gui-tool-inline">
              <TerminalSquare size={14} />
              <input value={terminalCommand} placeholder="Run terminal command..." onChange={(event) => setTerminalCommand(event.currentTarget.value)} onKeyDown={(event) => {
                if (event.key === 'Enter') runTerminalCommand(workspaceContext, terminalCommand, setTerminalCommand, setTerminalRun, pollTerminalRun, runPanelAction);
              }} />
              <button type="button" disabled={!workspaceContext || !terminalCommand.trim() || isBusy} onClick={() => runTerminalCommand(workspaceContext, terminalCommand, setTerminalCommand, setTerminalRun, pollTerminalRun, runPanelAction)}>
                <Play size={13} />
                Run
              </button>
              <button type="button" disabled={!terminalRun || !['queued', 'running'].includes(terminalRun.status) || isBusy} onClick={() => {
                if (!terminalRun) return;
                void runPanelAction('Terminal command cancelled', async () => {
                  const cancelled = await cancelPiWebTerminalCommandRun(terminalRun.id);
                  setTerminalRun(cancelled);
                  return cancelled.status;
                });
              }}>
                <Square size={12} />
              </button>
            </div>
            {terminalRun ? (
              <div className="pi-gui-capability-row">
                <Badge variant="light" color={terminalRun.status === 'failed' ? 'red' : terminalRun.status === 'succeeded' ? 'teal' : 'gray'}>
                  {terminalRun.status}
                </Badge>
                <Text size="xs" c="dimmed">{terminalRun.title}</Text>
                {terminalRun.exitCode !== undefined ? <Text size="xs" c="dimmed">exit {terminalRun.exitCode}</Text> : null}
              </div>
            ) : null}
          </div>
        </Tabs.Panel>
      </Tabs>

      <Modal opened={authOpen} onClose={() => setAuthOpen(false)} title="Provider authentication" centered radius="md" size="lg">
        <Stack gap="sm">
          <Group justify="space-between">
            <Text size="sm" c="dimmed">Use pi-web native auth routes for provider login and API keys.</Text>
            <Tooltip label="Refresh providers">
              <ActionIcon variant="subtle" color="gray" loading={authLoading} onClick={() => void refreshAuthProviders()}>
                <RefreshCw size={16} />
              </ActionIcon>
            </Tooltip>
          </Group>
          <ScrollArea.Autosize mah={320} type="never">
            <Stack gap="xs">
              {authProviders.map(provider => (
                <div key={provider.id} className="pi-gui-auth-provider">
                  <div>
                    <Text fw={650} size="sm">{provider.name}</Text>
                    <Text size="xs" c="dimmed">{provider.authType} · {provider.status.configured ? provider.status.label || provider.status.source || 'configured' : 'not configured'}</Text>
                  </div>
                  {provider.authType === 'api_key' ? (
                    <PasswordInput
                      size="xs"
                      placeholder="API key"
                      value={apiKeys[provider.id] || ''}
                      onChange={(event) => setApiKeys(current => ({ ...current, [provider.id]: event.currentTarget.value }))}
                    />
                  ) : null}
                  <Group gap="xs" wrap="nowrap">
                    {provider.authType === 'api_key' ? (
                      <Button size="xs" color="teal" variant="light" leftSection={<Check size={14} />} disabled={!apiKeys[provider.id]?.trim()} onClick={() => {
                        void runPanelAction(`${provider.name} key saved`, async () => {
                          await savePiWebApiKey(provider.id, apiKeys[provider.id].trim());
                          await refreshAuthProviders();
                        });
                      }}>
                        Save
                      </Button>
                    ) : (
                      <Button size="xs" color="teal" variant="light" leftSection={<KeyRound size={14} />} onClick={() => {
                        void runPanelAction(`${provider.name} OAuth started`, async () => {
                          const flow = await startPiWebOAuth(provider.id);
                          setOauthFlow(flow);
                          if (flow.auth?.url) window.open(flow.auth.url, '_blank', 'noopener,noreferrer');
                          await pollOAuth(flow.flowId);
                        });
                      }}>
                        OAuth
                      </Button>
                    )}
                    {provider.status.configured ? (
                      <Button size="xs" variant="subtle" color="gray" leftSection={<LogOut size={14} />} onClick={() => {
                        void runPanelAction(`${provider.name} logged out`, async () => {
                          await logoutPiWebProvider(provider.id);
                          await refreshAuthProviders();
                        });
                      }}>
                        Logout
                      </Button>
                    ) : null}
                  </Group>
                </div>
              ))}
            </Stack>
          </ScrollArea.Autosize>
          {oauthFlow ? (
            <div className="pi-gui-oauth-flow">
              <Group justify="space-between">
                <Text fw={650} size="sm">{oauthFlow.providerName}</Text>
                <Badge variant="light">{oauthFlow.status}</Badge>
              </Group>
              {oauthFlow.auth?.url ? <Text component="a" size="xs" href={oauthFlow.auth.url} target="_blank" rel="noreferrer">{oauthFlow.auth.url}</Text> : null}
              {oauthFlow.progress.map((item, index) => <Text key={`${item}-${index}`} size="xs" c="dimmed">{item}</Text>)}
              {oauthFlow.prompt ? (
                <Group gap="xs" align="end">
                  <TextInput size="xs" label={oauthFlow.prompt.message} placeholder={oauthFlow.prompt.placeholder} value={oauthResponse} onChange={(event) => setOauthResponse(event.currentTarget.value)} />
                  <Button size="xs" color="teal" onClick={() => {
                    void runPanelAction('OAuth response sent', async () => {
                      const next = await respondPiWebOAuth(oauthFlow.flowId, oauthFlow.prompt!.requestId, oauthResponse);
                      setOauthFlow(next);
                      setOauthResponse('');
                      await pollOAuth(next.flowId);
                    });
                  }}>
                    Send
                  </Button>
                </Group>
              ) : null}
              {oauthFlow.select ? (
                <Group gap="xs">
                  {oauthFlow.select.options.map(option => (
                    <Button key={option.value} size="xs" variant="light" onClick={() => {
                      void runPanelAction('OAuth option selected', async () => {
                        const next = await respondPiWebOAuth(oauthFlow.flowId, oauthFlow.select!.requestId, option.value);
                        setOauthFlow(next);
                        await pollOAuth(next.flowId);
                      });
                    }}>
                      {option.label}
                    </Button>
                  ))}
                </Group>
              ) : null}
              {oauthFlow.status === 'running' ? (
                <Button size="xs" variant="subtle" color="gray" onClick={() => {
                  void runPanelAction('OAuth cancelled', async () => {
                    const next = await cancelPiWebOAuth(oauthFlow.flowId);
                    setOauthFlow(next);
                  });
                }}>
                  Cancel OAuth
                </Button>
              ) : null}
            </div>
          ) : null}
        </Stack>
      </Modal>
    </section>
  );
}

function FileTreeButton({
  entry,
  onOpenDirectory,
  onReadFile,
}: {
  entry: PiWebFileTreeEntry;
  onOpenDirectory: (path: string) => void;
  onReadFile: (path: string) => void;
}) {
  const isDirectory = entry.type === 'directory';
  return (
    <button type="button" onClick={() => isDirectory ? onOpenDirectory(entry.path) : onReadFile(entry.path)}>
      {isDirectory ? <ChevronRight size={13} /> : <FileText size={13} />}
      <span>{entry.path || entry.name}</span>
      <Badge size="xs" variant="light">{entry.type}</Badge>
    </button>
  );
}

function runTerminalCommand(
  workspaceContext: PiWebWorkspaceContext | null,
  command: string,
  setCommand: (value: string) => void,
  setRun: (value: PiWebTerminalCommandRun | null) => void,
  pollRun: (runId: string) => Promise<PiWebTerminalCommandRun>,
  runPanelAction: (label: string, action: () => Promise<string | void>) => void,
) {
  const trimmed = command.trim();
  if (!workspaceContext || !trimmed) return;
  setCommand('');
  void runPanelAction('Terminal command started', async () => {
    const run = await runPiWebTerminalCommand(workspaceContext, {
      title: summarizeCommand(trimmed),
      command: trimmed,
      metadata: { source: 'agswarm-chat' },
    });
    setRun(run);
    const completed = await pollRun(run.id);
    return `${completed.title} · ${completed.status}${completed.exitCode === undefined ? '' : ` · exit ${completed.exitCode}`}`;
  });
}

function summarizeCommand(command: string): string {
  const compact = command.replace(/\s+/g, ' ').trim();
  return compact.length <= 64 ? compact : `${compact.slice(0, 61)}...`;
}

function truncateText(value: string, maxLength: number): string {
  const text = value.trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}...`;
}

function friendlyPanelError(message: string): string {
  if (/failed to fetch|connection|ECONNREFUSED/i.test(message)) {
    return 'Ag runtime is not reachable. Refresh the conversation or restart the desktop app.';
  }
  return message;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}
