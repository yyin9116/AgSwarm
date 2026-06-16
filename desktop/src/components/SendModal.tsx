import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  FileButton,
  Group,
  Modal,
  Paper,
  SegmentedControl,
  Select,
  Stack,
  Text,
  Textarea,
  ThemeIcon,
} from '@mantine/core';
import { AlertCircle, Send, Terminal, Upload } from 'lucide-react';
import type { Device } from './DevicesView';
import type { SendTaskData } from '../types/agswarm';

interface SendModalProps {
  device: Device | null;
  onClose: () => void;
  onSend: (task: SendTaskData) => void;
  initialFile?: File | null;
  initialTaskType?: 'echo' | 'latex' | 'agent' | 'file';
}

type ModalTaskType = 'echo' | 'latex' | 'agent' | 'file';

export function SendModal({ device, onClose, onSend, initialFile, initialTaskType }: SendModalProps) {
  const [taskType, setTaskType] = useState<ModalTaskType>(initialTaskType || 'echo');
  const [payload, setPayload] = useState('');
  const [skill, setSkill] = useState('safe_default');
  const [selectedFile, setSelectedFile] = useState<File | null>(initialFile || null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (initialFile) setSelectedFile(initialFile);
    if (initialTaskType) setTaskType(initialTaskType);
  }, [initialFile, initialTaskType]);

  const validationMessage = validateTask(taskType, payload, selectedFile);

  const handleSend = () => {
    if (!device) return;
    if (validationMessage) {
      setError(validationMessage);
      return;
    }
    onSend({
      type: taskType === 'echo' ? 'Echo' : taskType === 'latex' ? 'LaTeX' : taskType === 'agent' ? 'Agent' : 'File',
      target: device.id,
      payload: taskType === 'file' ? (payload ? `[File: ${selectedFile?.name}] ${payload}` : selectedFile?.name || '') : payload,
      skill: taskType === 'agent' ? skill : undefined,
      file: selectedFile || undefined,
      fileName: selectedFile?.name,
      fileSize: selectedFile ? `${(selectedFile.size / 1024).toFixed(1)} KB` : undefined,
    });
    setPayload('');
    setSelectedFile(null);
    setError('');
    onClose();
  };

  return (
    <Modal
      opened={Boolean(device)}
      onClose={onClose}
      title={device ? `Send to ${device.name}` : 'Send task'}
      size="lg"
      centered
      radius="md"
    >
      {device && (
        <Stack gap="md">
          <Text c="dimmed" ff="monospace" size="xs">{device.id}</Text>
          <SegmentedControl
            fullWidth
            value={taskType}
            onChange={(value) => {
              setTaskType(value as ModalTaskType);
              setError('');
            }}
            data={[
              { label: 'Echo', value: 'echo' },
              { label: 'LaTeX', value: 'latex' },
              { label: 'Agent', value: 'agent' },
              { label: 'File', value: 'file' },
            ]}
          />

          {taskType !== 'file' && (
            <Textarea
              autosize
              minRows={taskType === 'latex' ? 7 : 5}
              label={taskType === 'agent' ? 'Prompt' : taskType === 'latex' ? 'LaTeX Source' : 'Message'}
              placeholder={taskType === 'agent' ? 'Ask the agent to do something...' : taskType === 'latex' ? '\\documentclass{article}...' : 'Type a message...'}
              value={payload}
              onChange={(event) => {
                setPayload(event.currentTarget.value);
                setError('');
              }}
            />
          )}

          {taskType === 'agent' && (
            <Paper withBorder radius="md" p="md">
              <Group justify="space-between" wrap="nowrap">
                <Group gap="sm">
                  <ThemeIcon variant="light" color="gray"><Terminal size={16} /></ThemeIcon>
                  <Text size="sm" fw={600}>Skill Profile</Text>
                </Group>
                <Select
                  value={skill}
                  onChange={(value) => setSkill(value || 'safe_default')}
                  data={[
                    { value: 'safe_default', label: 'safe_default' },
                    { value: 'full_access', label: 'full_access' },
                  ]}
                  w={180}
                />
              </Group>
            </Paper>
          )}

          {taskType === 'file' && (
            <Stack gap="sm">
              <FileButton onChange={(file) => {
                setSelectedFile(file);
                setError('');
              }}>
                {(props) => (
                  <Button {...props} variant="light" color="teal" leftSection={<Upload size={16} />} h={72}>
                    {selectedFile ? selectedFile.name : 'Choose file'}
                  </Button>
                )}
              </FileButton>
              <Textarea
                autosize
                minRows={3}
                label="Instructions"
                placeholder="What should the device do with this file?"
                value={payload}
                onChange={(event) => setPayload(event.currentTarget.value)}
              />
            </Stack>
          )}

          {error && (
            <Alert color="red" icon={<AlertCircle size={16} />}>
              {error}
            </Alert>
          )}

          <Button
            color="teal"
            size="md"
            leftSection={<Send size={16} />}
            onClick={handleSend}
            disabled={Boolean(validationMessage)}
          >
            {taskType === 'file' ? (selectedFile ? `Send ${selectedFile.name}` : 'Send File') : 'Send Task'}
          </Button>
        </Stack>
      )}
    </Modal>
  );
}

function validateTask(taskType: ModalTaskType, payload: string, file: File | null): string {
  if (taskType === 'file' && !file) return 'Choose a file before sending.';
  if (taskType !== 'file' && !payload.trim()) return 'Enter content before sending.';
  return '';
}
