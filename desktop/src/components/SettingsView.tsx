import { Play, Moon, Sun, Key, Folder, BrainCircuit, Cpu, Save, CheckCircle2, Radar } from 'lucide-react';
import { useState } from 'react';

interface SettingsViewProps {
  onSimulateIncoming: () => void;
  theme: 'light' | 'dark';
  onThemeChange: (theme: 'light' | 'dark') => void;
  providerUrl: string;
  onProviderUrlChange: (value: string) => void;
  apiKey: string;
  onApiKeyChange: (value: string) => void;
  modelName: string;
  onModelNameChange: (value: string) => void;
}

export function SettingsView({
  onSimulateIncoming,
  theme,
  onThemeChange,
  providerUrl,
  onProviderUrlChange,
  apiKey,
  onApiKeyChange,
  modelName,
  onModelNameChange,
}: SettingsViewProps) {
  const [defaultPath, setDefaultPath] = useState('~/Downloads/AgentTasks');
  const [agentSkills, setAgentSkills] = useState('safe_default, file_system, shell');
  const [isSaved, setIsSaved] = useState(false);

  const handleSave = () => {
    setIsSaved(true);
    setTimeout(() => setIsSaved(false), 2000);
  };

  return (
    <div className="p-6 max-w-3xl mx-auto pt-12 pb-32">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-3xl font-semibold tracking-tight dark:text-white">Settings</h1>
        <button 
          onClick={handleSave}
          className="flex items-center gap-2 bg-teal-600 hover:bg-teal-700 text-white px-5 py-2.5 rounded-xl text-sm font-medium transition-all shadow-sm shadow-teal-600/20"
        >
          {isSaved ? <CheckCircle2 className="w-4 h-4" /> : <Save className="w-4 h-4" />}
          {isSaved ? 'Saved!' : 'Save Changes'}
        </button>
      </div>
      
      <div className="space-y-6">
        {/* General Settings */}
        <div className="bg-white dark:bg-gray-900 rounded-3xl shadow-sm border border-gray-100 dark:border-gray-800 overflow-hidden">
          <div className="p-5 border-b border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/50">
            <h2 className="font-semibold text-gray-900 dark:text-white flex items-center gap-2">
              <Sun className="w-4 h-4 text-gray-500" /> General
            </h2>
          </div>
          <div className="p-5 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between">
            <div>
              <h3 className="font-medium text-gray-900 dark:text-gray-100">Appearance</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400">Toggle dark mode</p>
            </div>
            <div className="flex items-center bg-gray-100 dark:bg-gray-800 rounded-xl p-1">
              <button
                onClick={() => onThemeChange('light')}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  theme === 'light' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                <Sun className="w-4 h-4" /> Light
              </button>
              <button
                onClick={() => onThemeChange('dark')}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  theme === 'dark' ? 'bg-gray-700 text-white shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                <Moon className="w-4 h-4" /> Dark
              </button>
            </div>
          </div>
          <div className="p-5 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between">
            <div>
              <h3 className="font-medium text-gray-900 dark:text-gray-100">Device Name</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400">How you appear to others</p>
            </div>
            <input 
              type="text" 
              defaultValue="My Desktop"
              className="bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white text-sm rounded-xl px-4 py-2 focus:outline-none focus:ring-2 focus:ring-teal-500 w-48 text-right font-medium"
            />
          </div>
          <div className="p-5 flex items-center justify-between">
            <div>
              <h3 className="font-medium text-gray-900 dark:text-gray-100">Default Save Path</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400">Where received files are saved</p>
            </div>
            <div className="flex items-center gap-2 w-64">
              <Folder className="w-4 h-4 text-gray-400 absolute ml-3 pointer-events-none" />
              <input 
                type="text" 
                value={defaultPath}
                onChange={(e) => setDefaultPath(e.target.value)}
                className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white text-sm rounded-xl pl-9 pr-4 py-2 focus:outline-none focus:ring-2 focus:ring-teal-500 font-mono"
              />
            </div>
          </div>
        </div>

        {/* AI & Agent Settings */}
        <div className="bg-white dark:bg-gray-900 rounded-3xl shadow-sm border border-gray-100 dark:border-gray-800 overflow-hidden">
          <div className="p-5 border-b border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/50">
            <h2 className="font-semibold text-gray-900 dark:text-white flex items-center gap-2">
              <BrainCircuit className="w-4 h-4 text-teal-500" /> AI & Agent Configuration
            </h2>
          </div>
          <div className="p-5 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between">
            <div className="pr-4">
              <h3 className="font-medium text-gray-900 dark:text-gray-100">API Key</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400">Bearer key for the local OpenAI-compatible provider</p>
            </div>
            <div className="flex items-center gap-2 w-64 relative">
              <Key className="w-4 h-4 text-gray-400 absolute ml-3 pointer-events-none" />
              <input 
                type="password" 
                value={apiKey}
                onChange={(e) => onApiKeyChange(e.target.value)}
                placeholder="local-dev-key"
                className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white text-sm rounded-xl pl-9 pr-4 py-2 focus:outline-none focus:ring-2 focus:ring-teal-500 font-mono"
              />
            </div>
          </div>
          <div className="p-5 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between">
            <div>
              <h3 className="font-medium text-gray-900 dark:text-gray-100">Default Model</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400">Model used for reasoning</p>
            </div>
            <div className="relative w-64">
              <Cpu className="w-4 h-4 text-gray-400 absolute ml-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <select 
                value={modelName}
                onChange={(e) => onModelNameChange(e.target.value)}
                className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white text-sm rounded-xl pl-9 pr-4 py-2 focus:outline-none focus:ring-2 focus:ring-teal-500 appearance-none cursor-pointer font-mono"
              >
                <option value="gpt-5.5">gpt-5.5</option>
                <option value="gpt-5.4">gpt-5.4</option>
                <option value="gpt-5.4-mini">gpt-5.4-mini</option>
              </select>
            </div>
          </div>
          <div className="p-5 flex items-start justify-between">
            <div className="pr-4">
              <h3 className="font-medium text-gray-900 dark:text-gray-100">Agent Skills</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400">Comma-separated list of allowed skills</p>
            </div>
            <textarea 
              value={agentSkills}
              onChange={(e) => setAgentSkills(e.target.value)}
              className="w-64 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white text-sm rounded-xl p-3 focus:outline-none focus:ring-2 focus:ring-teal-500 font-mono resize-none h-20"
            />
          </div>
        </div>

        {/* Network Settings */}
        <div className="bg-white dark:bg-gray-900 rounded-3xl shadow-sm border border-gray-100 dark:border-gray-800 overflow-hidden">
          <div className="p-5 border-b border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/50">
            <h2 className="font-semibold text-gray-900 dark:text-white flex items-center gap-2">
              <Radar className="w-4 h-4 text-blue-500" /> Network
            </h2>
          </div>
          <div className="p-5 flex items-center justify-between">
            <div>
              <h3 className="font-medium text-gray-900 dark:text-gray-100">Agent Provider</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400">Local OpenAI-compatible HTTP endpoint</p>
            </div>
            <input 
              type="text" 
              value={providerUrl}
              onChange={(e) => onProviderUrlChange(e.target.value)}
              placeholder="http://127.0.0.1:15721"
              className="bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white text-sm rounded-xl px-4 py-2 focus:outline-none focus:ring-2 focus:ring-teal-500 w-64 font-mono"
            />
          </div>
          <div className="p-5 border-t border-gray-100 dark:border-gray-800 flex items-center justify-between">
            <div>
              <h3 className="font-medium text-gray-900 dark:text-gray-100">NATS Server</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400">Control plane address</p>
            </div>
            <input
              type="text"
              defaultValue="nats://127.0.0.1:4222"
              className="bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white text-sm rounded-xl px-4 py-2 focus:outline-none focus:ring-2 focus:ring-teal-500 w-64 font-mono"
            />
          </div>
        </div>

        {/* Developer Tools */}
        <div className="bg-indigo-50 dark:bg-indigo-900/20 rounded-3xl p-6 border border-indigo-100 dark:border-indigo-800/50">
          <h3 className="font-medium text-indigo-900 dark:text-indigo-300 mb-2">Developer Tools</h3>
          <p className="text-sm text-indigo-700 dark:text-indigo-400 mb-4">Simulate receiving a task from another device on the network to test the receiver UI.</p>
          <button 
            onClick={onSimulateIncoming}
            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors"
          >
            <Play className="w-4 h-4" />
            Simulate Incoming Task
          </button>
        </div>
      </div>
    </div>
  );
}
