import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, ExternalLink, RefreshCw } from 'lucide-react';
import { ActionIcon, Button, Group, Loader, Paper, Stack, Text } from '@mantine/core';
import { startPiWeb } from '../lib/agswarmApi';
import type { PiWebStatus } from '../types/agswarm';

type PiWebEmbedViewProps = {
  className?: string;
};

export function PiWebEmbedView({ className }: PiWebEmbedViewProps) {
  const [status, setStatus] = useState<PiWebStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(true);
  const [frameKey, setFrameKey] = useState(0);

  const start = useCallback(async () => {
    setIsStarting(true);
    setError(null);
    try {
      const nextStatus = await startPiWeb();
      setStatus(nextStatus);
      if (!nextStatus.ok || !nextStatus.running) {
        setError(nextStatus.message || 'AgSwarm AI runtime is not running.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsStarting(false);
    }
  }, []);

  useEffect(() => {
    void start();
  }, [start]);

  const url = status?.url || 'http://127.0.0.1:8504';
  const canShowFrame = status?.ok && status.running && !error;

  return (
    <section className={`agswarm-pi-web ${className || ''}`} aria-label="AgSwarm AI chat">
      <div className="agswarm-pi-web-toolbar">
        <div>
          <Text fw={650} size="sm">AgSwarm AI</Text>
          <Text size="xs" c="dimmed">AgSwarm native AI control surface</Text>
        </div>
        <Group gap="xs" wrap="nowrap">
          {isStarting ? <Loader size="sm" /> : null}
          <ActionIcon
            aria-label="Reload AgSwarm AI"
            variant="subtle"
            color="gray"
            onClick={() => {
              setFrameKey(value => value + 1);
              void start();
            }}
          >
            <RefreshCw size={17} />
          </ActionIcon>
          <ActionIcon
            aria-label="Open AgSwarm AI in browser"
            variant="subtle"
            color="gray"
            component="a"
            href={url}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink size={17} />
          </ActionIcon>
        </Group>
      </div>

      {canShowFrame ? (
        <iframe
          key={frameKey}
          title="AgSwarm AI"
          className="agswarm-pi-web-frame"
          src={url}
          sandbox="allow-same-origin allow-scripts allow-forms allow-downloads allow-popups allow-modals"
        />
      ) : (
        <Paper className="agswarm-pi-web-state" withBorder>
          <Stack gap="sm" align="center">
            {isStarting ? <Loader size="md" /> : <AlertCircle size={24} />}
            <Text fw={650}>{isStarting ? '正在启动 AgSwarm AI' : 'AgSwarm AI 未能启动'}</Text>
            <Text size="sm" c="dimmed" ta="center" maw={680}>
              {error || status?.message || '等待桌面端启动 AgSwarm AI 运行时。'}
            </Text>
            {!isStarting ? (
              <Button variant="light" leftSection={<RefreshCw size={16} />} onClick={() => void start()}>
                重试
              </Button>
            ) : null}
          </Stack>
        </Paper>
      )}
    </section>
  );
}
