import { useState } from 'react';
import { Radar, ArrowRightLeft, Settings, MessageSquareText } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { DevicesView, Device, FileTransfer } from './components/DevicesView';
import { TasksView, Task } from './components/TasksView';
import { SettingsView } from './components/SettingsView';
import { SendModal } from './components/SendModal';
import { ChatView, ChatMessage } from './components/ChatView';

const MY_DEVICE_ID = 'node-a'; // Let's say we are node-a (MacBook Pro)
const DEFAULT_PROVIDER_URL = import.meta.env.VITE_AGENT_PROVIDER_URL || 'http://127.0.0.1:15721';
const DEFAULT_AGENT_MODEL = import.meta.env.VITE_AGENT_MODEL || 'gpt-5.5';
const DEFAULT_AGENT_API_KEY = import.meta.env.VITE_AGENT_API_KEY || 'local-dev-key';

const INITIAL_DEVICES: Device[] = [
  { id: 'node-a', name: 'MacBook Pro (This Device)', type: 'laptop', os: 'macOS', status: 'online', ipAddress: '192.168.1.10', storage: '245 GB free', networkType: 'Wi-Fi', backgroundTasks: ['Syncing iCloud', 'Time Machine Backup'] },
  { id: 'node-b', name: 'Studio Display', type: 'desktop', os: 'Windows', status: 'transferring', ipAddress: '192.168.1.11', storage: '1.2 TB free', networkType: 'Ethernet', backgroundTasks: ['Windows Update'] },
  { id: 'node-c', name: 'iPhone 15', type: 'mobile', os: 'iOS', status: 'idle', ipAddress: '192.168.1.12', storage: '45 GB free', networkType: 'Wi-Fi', backgroundTasks: [] },
  { id: 'node-d', name: 'Living Room TV', type: 'desktop', os: 'Android TV', status: 'offline', ipAddress: '192.168.1.15', storage: '8 GB free', networkType: 'Wi-Fi', backgroundTasks: [] },
];

const INITIAL_TRANSFERS: FileTransfer[] = [
  { id: 'tf-1', fileName: 'project_assets.zip', targetDeviceName: 'Studio Display', progress: 45, status: 'transferring', size: '1.2 GB' },
  { id: 'tf-2', fileName: 'meeting_notes.pdf', targetDeviceName: 'iPhone 15', progress: 100, status: 'completed', size: '2.4 MB' },
  { id: 'tf-3', fileName: 'dataset_v2.csv', targetDeviceName: 'Living Room TV', progress: 0, status: 'failed', size: '450 MB' },
];

const INITIAL_TASKS: Task[] = [
  { id: 'tsk-1', type: 'Echo', target: 'node-b', direction: 'outgoing', status: 'completed', time: '2 mins ago', detail: 'hello workflow' },
  { id: 'tsk-2', type: 'LaTeX', target: 'node-b', direction: 'outgoing', status: 'running', time: 'Just now', detail: 'Compile document.tex' },
  { id: 'tsk-3', type: 'Agent', target: 'node-c', direction: 'outgoing', status: 'failed', time: '1 hour ago', detail: 'Skill: safe_default' },
];

const INITIAL_MESSAGES: ChatMessage[] = [
  {
    id: 'msg-0',
    role: 'agent',
    content: "Hello! I am your AgSwarm Agent. You can ask me to orchestrate tasks across your devices. For example, try saying: \"Generate an image on my Windows PC\" or \"Compile a latex file\"."
  }
];

export default function App() {
  const [currentTab, setCurrentTab] = useState('chat');
  const [devices, setDevices] = useState<Device[]>(INITIAL_DEVICES);
  const [selectedDevice, setSelectedDevice] = useState<Device | null>(null);
  const [selectedFileForDevice, setSelectedFileForDevice] = useState<File | null>(null);
  const [tasks, setTasks] = useState<Task[]>(INITIAL_TASKS);
  const [transfers, setTransfers] = useState<FileTransfer[]>(INITIAL_TRANSFERS);
  const [messages, setMessages] = useState<ChatMessage[]>(INITIAL_MESSAGES);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [providerUrl, setProviderUrl] = useState(DEFAULT_PROVIDER_URL);
  const [agentModel, setAgentModel] = useState(DEFAULT_AGENT_MODEL);
  const [agentApiKey, setAgentApiKey] = useState(DEFAULT_AGENT_API_KEY);

  const handleCancelTransfer = (transferId: string) => {
    setTransfers(prev => prev.map(t => 
      t.id === transferId ? { ...t, status: 'failed' } : t
    ));
  };

  const handleSelectDevice = (device: Device, file?: File) => {
    setSelectedDevice(device);
    if (file) {
      setSelectedFileForDevice(file);
    } else {
      setSelectedFileForDevice(null);
    }
  };

  const tabs = [
    { id: 'chat', icon: MessageSquareText, label: 'Copilot' },
    { id: 'devices', icon: Radar, label: 'Devices' },
    { id: 'tasks', icon: ArrowRightLeft, label: 'Tasks' },
    { id: 'settings', icon: Settings, label: 'Settings' },
  ];

  const handleSendTask = (taskData: any) => {
    const newTask: Task = {
      id: `tsk-${Date.now()}`,
      type: taskData.type,
      target: taskData.target,
      direction: 'outgoing',
      status: 'running',
      time: 'Just now',
      detail: taskData.type === 'Agent' ? `Skill: ${taskData.skill}` : taskData.type === 'File' ? 'Uploading file...' : taskData.payload.substring(0, 30) + '...',
    };
    setTasks([newTask, ...tasks]);
    setCurrentTab('tasks');
  };

  const handleAgentMessage = async (content: string, file?: File) => {
    // 1. Add user message
    const userMsg: ChatMessage = { 
      id: `msg-${Date.now()}`, 
      role: 'user', 
      content,
      attachment: file ? { name: file.name, size: `${(file.size / 1024).toFixed(1)} KB` } : undefined
    };
    setMessages(prev => [...prev, userMsg]);

    // 2. Add thinking agent message
    const agentMsgId = `msg-${Date.now() + 1}`;
    setMessages(prev => [...prev, { id: agentMsgId, role: 'agent', content: '', isThinking: true }]);

    try {
      const promptContent = file ? `[Attached file: ${file.name}]\n${content}` : content;
      const agentPlan = await requestAgentPlan({
        providerUrl,
        apiKey: agentApiKey,
        model: agentModel,
        prompt: promptContent,
      });

      if (agentPlan.intent === 'orchestrate') {
        const args = agentPlan;
        
        const requestedType = args.targetDeviceType?.toLowerCase() || '';
        let targetDevice = devices.find(d => d.os.toLowerCase().includes(requestedType) || d.type.toLowerCase().includes(requestedType));
        if (!targetDevice) {
          targetDevice = devices.find(d => d.id !== MY_DEVICE_ID) || devices[0];
        }
        
        const taskType = args.taskType || 'Echo';
        const payload = args.payload || content;
        const isImage = taskType === 'Agent' || payload.toLowerCase().includes('image');

        // Update agent message with task proposal (Created)
        setMessages(prev => prev.map(msg => msg.id === agentMsgId ? {
          ...msg,
          isThinking: false,
          content: `I've understood your request. Dispatching a ${taskType} task to ${targetDevice.name}.`,
          taskProposal: {
            direction: 'outgoing',
            targetDeviceId: targetDevice.id,
            targetDeviceName: targetDevice.name,
            taskType,
            payload,
            status: 'created'
          }
        } : msg));

        // 4. Dispatching
        setTimeout(() => {
          setMessages(prev => prev.map(msg => msg.id === agentMsgId ? {
            ...msg,
            taskProposal: { ...msg.taskProposal!, status: 'dispatching' }
          } : msg));

          // Add to Tasks history as running
          const newTaskId = `tsk-${Date.now()}`;
          const newTask: Task = {
            id: newTaskId,
            type: taskType as any,
            target: targetDevice.id,
            direction: 'outgoing',
            status: 'running',
            time: 'Just now',
            detail: payload.substring(0, 30) + '...'
          };
          setTasks(prev => [newTask, ...prev]);

          // 5. Accepted
          setTimeout(() => {
            setDevices(prev => prev.map(d => d.id === targetDevice.id ? {
              ...d,
              activeTask: { type: taskType, status: 'receiving' }
            } : d));

            setMessages(prev => prev.map(msg => msg.id === agentMsgId ? {
              ...msg,
              taskProposal: { ...msg.taskProposal!, status: 'accepted' }
            } : msg));

            // 6. Running
            setTimeout(() => {
              setDevices(prev => prev.map(d => d.id === targetDevice.id ? {
                ...d,
                activeTask: { type: taskType, status: 'executing' }
              } : d));

              setMessages(prev => prev.map(msg => msg.id === agentMsgId ? {
                ...msg,
                taskProposal: { ...msg.taskProposal!, status: 'running' }
              } : msg));

              // 7. Completed
              setTimeout(() => {
                setDevices(prev => prev.map(d => d.id === targetDevice.id ? { ...d, activeTask: null } : d));
                
                let preview;
                if (taskType === 'LaTeX') {
                  preview = { type: 'pdf' as const, url: '#', name: 'document.pdf' };
                } else if (isImage) {
                  preview = { type: 'image' as const, url: 'https://picsum.photos/seed/agswarm/600/400', name: 'generated_image.png' };
                }

                setMessages(prev => prev.map(msg => msg.id === agentMsgId ? {
                  ...msg,
                  taskProposal: { 
                    ...msg.taskProposal!, 
                    status: 'completed', 
                    result: taskType === 'Echo' ? 'Message delivered successfully.' : isImage ? 'Image generated successfully.' : 'Compiled PDF returned.',
                    preview
                  },
                  followUpOptions: taskType === 'LaTeX' ? ['Open PDF', 'Send to another device'] : isImage ? ['Save to Gallery', 'Upscale Image'] : ['Send another message']
                } : msg));

                setTasks(prev => prev.map(t => t.id === newTaskId ? { 
                  ...t, 
                  status: 'completed',
                  result: taskType === 'Echo' ? 'Message delivered successfully.' : isImage ? 'Image generated successfully.' : 'Compiled PDF returned.',
                  filePreview: preview
                } : t));
                
              }, 2500);
            }, 1500);
          }, 1000);
        }, 1000);
      } else {
        // Just a text response
        setMessages(prev => prev.map(msg => msg.id === agentMsgId ? {
          ...msg,
          isThinking: false,
          content: agentPlan.reply || "I'm sorry, I couldn't process that request.",
        } : msg));
      }
    } catch (error) {
      console.error("AgSwarm provider error:", error);
      setMessages(prev => prev.map(msg => msg.id === agentMsgId ? {
        ...msg,
        isThinking: false,
        content: `Local provider is not reachable at ${providerUrl}. I kept the UI ready; start the provider and try again.`,
      } : msg));
    }
  };

  const handleSimulateIncoming = () => {
    setCurrentTab('chat');
    const targetDevice = devices[1]; // Studio Display is sending to us
    const taskType = 'LaTeX';
    const payload = '\\documentclass{article}\\begin{document}Hello AgSwarm\\end{document}';
    
    // 1. Add system message
    const sysMsgId = `msg-${Date.now()}`;
    setMessages(prev => [...prev, { 
      id: sysMsgId, 
      role: 'system', 
      content: `Incoming task from ${targetDevice.name}. Auto-accepting based on safe_default skill profile.`,
      taskProposal: {
        direction: 'incoming',
        targetDeviceId: targetDevice.id,
        targetDeviceName: targetDevice.name,
        taskType,
        payload,
        status: 'accepted'
      }
    }]);

    // 2. Add to tasks as running
    const newTaskId = `tsk-${Date.now()}`;
    setTasks(prev => [{
      id: newTaskId,
      type: taskType as any,
      target: targetDevice.id,
      direction: 'incoming',
      status: 'running',
      time: 'Just now',
      detail: payload.substring(0, 30) + '...'
    }, ...prev]);

    // 3. Update MY device to receiving
    setDevices(prev => prev.map(d => d.id === MY_DEVICE_ID ? {
      ...d,
      activeTask: { type: taskType, status: 'receiving' }
    } : d));

    // 4. Running
    setTimeout(() => {
      setDevices(prev => prev.map(d => d.id === MY_DEVICE_ID ? {
        ...d,
        activeTask: { type: taskType, status: 'executing' }
      } : d));

      setMessages(prev => prev.map(msg => msg.id === sysMsgId ? {
        ...msg,
        taskProposal: { ...msg.taskProposal!, status: 'running' }
      } : msg));

      // 5. Completed
      setTimeout(() => {
        setDevices(prev => prev.map(d => d.id === MY_DEVICE_ID ? { ...d, activeTask: null } : d));
        
        setMessages(prev => prev.map(msg => msg.id === sysMsgId ? {
          ...msg,
          taskProposal: { 
            ...msg.taskProposal!, 
            status: 'completed', 
            result: 'Compilation successful. PDF sent back.',
            preview: { type: 'pdf' as const, url: '#', name: 'thesis_draft.pdf' }
          },
          followUpOptions: ['View Log', 'Reply to Studio Display']
        } : msg));

        setTasks(prev => prev.map(t => t.id === newTaskId ? { 
          ...t, 
          status: 'completed',
          result: 'Compilation successful. PDF sent back.',
          filePreview: { type: 'pdf' as const, url: '#', name: 'thesis_draft.pdf' }
        } : t));
      }, 3000);
    }, 1500);
  };

  return (
    <div className={`flex flex-col h-screen font-sans selection:bg-teal-500/30 bg-[#f5f5f7] dark:bg-gray-950 text-[#1d1d1f] dark:text-gray-100 ${theme === 'dark' ? 'dark' : ''}`}>
      <main className="flex-1 overflow-y-auto pb-24 overflow-x-hidden">
        <AnimatePresence mode="wait">
          {currentTab === 'chat' && (
            <motion.div
              key="chat"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              transition={{ duration: 0.2 }}
              className="h-full"
            >
              <ChatView messages={messages} onSendMessage={handleAgentMessage} />
            </motion.div>
          )}
          {currentTab === 'devices' && (
            <motion.div
              key="devices"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              transition={{ duration: 0.2 }}
              className="h-full"
            >
              <DevicesView 
                devices={devices} 
                transfers={transfers}
                onSelectDevice={handleSelectDevice} 
                onAddDevice={(device) => setDevices(prev => [...prev, device])}
                onCancelTransfer={handleCancelTransfer}
              />
            </motion.div>
          )}
          {currentTab === 'tasks' && (
            <motion.div
              key="tasks"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              transition={{ duration: 0.2 }}
              className="h-full"
            >
              <TasksView tasks={tasks} />
            </motion.div>
          )}
          {currentTab === 'settings' && (
            <motion.div
              key="settings"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              transition={{ duration: 0.2 }}
              className="h-full"
            >
              <SettingsView 
                onSimulateIncoming={handleSimulateIncoming} 
                theme={theme}
                onThemeChange={setTheme}
                providerUrl={providerUrl}
                onProviderUrlChange={setProviderUrl}
                apiKey={agentApiKey}
                onApiKeyChange={setAgentApiKey}
                modelName={agentModel}
                onModelNameChange={setAgentModel}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </main>
      
      {/* Bottom Nav for compact feel */}
      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-white/80 dark:bg-gray-900/80 backdrop-blur-xl border border-white/20 dark:border-gray-800 shadow-lg shadow-black/5 dark:shadow-black/50 rounded-full px-4 py-3 flex items-center gap-2 z-50">
        {tabs.map((tab) => {
          const isActive = currentTab === tab.id;
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => setCurrentTab(tab.id)}
              className={`relative flex items-center justify-center w-14 h-14 rounded-full transition-colors ${isActive ? 'text-teal-600 dark:text-teal-400' : 'text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300'}`}
              title={tab.label}
            >
              {isActive && (
                <motion.div
                  layoutId="active-tab"
                  className="absolute inset-0 bg-teal-50 dark:bg-teal-900/30 rounded-full"
                  transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                />
              )}
              <Icon className="w-6 h-6 relative z-10" strokeWidth={isActive ? 2.5 : 2} />
            </button>
          );
        })}
      </div>

      <SendModal 
        device={selectedDevice} 
        onClose={() => {
          setSelectedDevice(null);
          setSelectedFileForDevice(null);
        }} 
        onSend={handleSendTask}
        initialFile={selectedFileForDevice}
        initialTaskType={selectedFileForDevice ? 'file' : undefined}
      />
    </div>
  );
}

type AgentPlan =
  | {
      intent: 'orchestrate';
      targetDeviceType: string;
      taskType: 'Echo' | 'LaTeX' | 'Agent' | 'File';
      payload: string;
    }
  | {
      intent: 'reply';
      reply: string;
    };

async function requestAgentPlan({
  providerUrl,
  apiKey,
  model,
  prompt,
}: {
  providerUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
}): Promise<AgentPlan> {
  const endpoint = `${providerUrl.replace(/\/$/, '')}/v1/chat/completions`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey || 'local-dev-key'}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content:
            'You are AgSwarm Agent, a copilot that orchestrates tasks across devices. Return only compact JSON. Use {"intent":"orchestrate","targetDeviceType":"windows|mac|ios|android|desktop|mobile","taskType":"Echo|LaTeX|Agent|File","payload":"..."} when the user asks to do something on a device. Otherwise return {"intent":"reply","reply":"..."}',
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
    }),
  });
  if (!response.ok) {
    throw new Error(`provider returned ${response.status}`);
  }
  const payload = await response.json();
  const text = String(payload?.choices?.[0]?.message?.content || '').trim();
  return parseAgentPlan(text, prompt);
}

function parseAgentPlan(text: string, originalPrompt: string): AgentPlan {
  try {
    const parsed = JSON.parse(text) as Partial<AgentPlan>;
    if (parsed.intent === 'orchestrate') {
      return {
        intent: 'orchestrate',
        targetDeviceType: String(parsed.targetDeviceType || 'desktop'),
        taskType: normalizeTaskType(String(parsed.taskType || 'Agent')),
        payload: String(parsed.payload || originalPrompt),
      };
    }
    if (parsed.intent === 'reply') {
      return { intent: 'reply', reply: String(parsed.reply || text) };
    }
  } catch {
    // Fall through to heuristic handling.
  }
  const lower = originalPrompt.toLowerCase();
  if (/(send|run|compile|generate|open|copy|upload|download|device|windows|mac|iphone|android|latex|file)/.test(lower)) {
    return {
      intent: 'orchestrate',
      targetDeviceType: lower.includes('iphone') || lower.includes('ios') ? 'ios' : lower.includes('mac') ? 'mac' : lower.includes('android') ? 'android' : 'desktop',
      taskType: lower.includes('latex') ? 'LaTeX' : lower.includes('file') || lower.includes('upload') ? 'File' : lower.includes('echo') ? 'Echo' : 'Agent',
      payload: originalPrompt,
    };
  }
  return { intent: 'reply', reply: text || 'Ready to orchestrate tasks across your devices.' };
}

function normalizeTaskType(value: string): 'Echo' | 'LaTeX' | 'Agent' | 'File' {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'echo') return 'Echo';
  if (normalized === 'latex') return 'LaTeX';
  if (normalized === 'file') return 'File';
  return 'Agent';
}
