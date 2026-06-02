import { motion, AnimatePresence } from 'motion/react';
import { X, Send, Terminal } from 'lucide-react';
import React, { useState, useRef, useEffect } from 'react';
import { Device } from './DevicesView';

interface SendModalProps {
  device: Device | null;
  onClose: () => void;
  onSend: (task: any) => void;
  initialFile?: File | null;
  initialTaskType?: 'echo' | 'latex' | 'agent' | 'file';
}

export function SendModal({ device, onClose, onSend, initialFile, initialTaskType }: SendModalProps) {
  const [taskType, setTaskType] = useState<'echo' | 'latex' | 'agent' | 'file'>(initialTaskType || 'echo');
  const [payload, setPayload] = useState('');
  const [skill, setSkill] = useState('safe_default');
  const [selectedFile, setSelectedFile] = useState<File | null>(initialFile || null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (initialFile) {
      setSelectedFile(initialFile);
    }
    if (initialTaskType) {
      setTaskType(initialTaskType);
    }
  }, [initialFile, initialTaskType]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setSelectedFile(e.target.files[0]);
    }
  };

  const handleSend = () => {
    onSend({
      type: taskType === 'echo' ? 'Echo' : taskType === 'latex' ? 'LaTeX' : taskType === 'agent' ? 'Agent' : 'File',
      target: device?.id,
      payload: taskType === 'file' ? (payload ? `[File: ${selectedFile?.name}] ${payload}` : selectedFile?.name || '') : payload,
      skill: taskType === 'agent' ? skill : undefined,
    });
    setPayload('');
    setSelectedFile(null);
    onClose();
  };

  return (
    <AnimatePresence>
      {device && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50"
          />
          <motion.div
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            className="fixed bottom-0 left-0 right-0 bg-white dark:bg-gray-900 text-gray-900 dark:text-white rounded-t-[2rem] shadow-2xl z-50 max-h-[90vh] overflow-y-auto border-t border-gray-100 dark:border-gray-800"
          >
            <div className="p-6 max-w-3xl mx-auto">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h2 className="text-2xl font-semibold">Send to {device.name}</h2>
                  <p className="text-gray-500 dark:text-gray-400 text-sm font-mono mt-1">{device.id}</p>
                </div>
                <button onClick={onClose} className="p-2 bg-gray-100 dark:bg-gray-800 rounded-full hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors">
                  <X className="w-5 h-5 text-gray-600 dark:text-gray-300" />
                </button>
              </div>

              <div className="flex gap-2 mb-6 bg-gray-50 dark:bg-gray-800 p-1 rounded-2xl">
                {(['echo', 'latex', 'agent', 'file'] as const).map(type => (
                  <button
                    key={type}
                    onClick={() => setTaskType(type as any)}
                    className={`flex-1 py-2.5 px-2 sm:px-4 rounded-xl text-sm font-medium capitalize transition-all ${
                      taskType === type ? 'bg-white dark:bg-gray-700 text-teal-600 dark:text-teal-400 shadow-sm' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
                    }`}
                  >
                    {type}
                  </button>
                ))}
              </div>

              <div className="space-y-4">
                {taskType === 'echo' && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Message</label>
                    <textarea
                      value={payload}
                      onChange={e => setPayload(e.target.value)}
                      placeholder="Type a message..."
                      className="w-full bg-gray-50 dark:bg-gray-800 border-transparent text-gray-900 dark:text-white focus:bg-white dark:focus:bg-gray-800 focus:border-teal-500 focus:ring-2 focus:ring-teal-200 dark:focus:ring-teal-500/50 rounded-2xl p-4 min-h-[120px] transition-all resize-none outline-none placeholder-gray-400 dark:placeholder-gray-500"
                    />
                  </div>
                )}
                
                {taskType === 'latex' && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">LaTeX Source</label>
                    <textarea
                      value={payload}
                      onChange={e => setPayload(e.target.value)}
                      placeholder="\documentclass{article}..."
                      className="w-full bg-gray-50 dark:bg-gray-800 border-transparent text-gray-900 dark:text-white focus:bg-white dark:focus:bg-gray-800 focus:border-teal-500 focus:ring-2 focus:ring-teal-200 dark:focus:ring-teal-500/50 rounded-2xl p-4 min-h-[160px] font-mono text-sm transition-all resize-none outline-none placeholder-gray-400 dark:placeholder-gray-500"
                    />
                  </div>
                )}

                {taskType === 'agent' && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Prompt</label>
                    <textarea
                      value={payload}
                      onChange={e => setPayload(e.target.value)}
                      placeholder="Ask the agent to do something..."
                      className="w-full bg-gray-50 dark:bg-gray-800 border-transparent text-gray-900 dark:text-white focus:bg-white dark:focus:bg-gray-800 focus:border-teal-500 focus:ring-2 focus:ring-teal-200 dark:focus:ring-teal-500/50 rounded-2xl p-4 min-h-[120px] transition-all resize-none outline-none placeholder-gray-400 dark:placeholder-gray-500"
                    />
                    <div className="mt-4 flex items-center justify-between bg-gray-50 dark:bg-gray-800 p-4 rounded-2xl">
                      <div className="flex items-center gap-3">
                        <Terminal className="w-5 h-5 text-gray-400" />
                        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Skill Profile</span>
                      </div>
                      <select 
                        value={skill}
                        onChange={e => setSkill(e.target.value)}
                        className="bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 text-gray-900 dark:text-white text-sm rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-teal-500 cursor-pointer"
                      >
                        <option value="safe_default">safe_default</option>
                        <option value="full_access">full_access</option>
                      </select>
                    </div>
                  </div>
                )}

                {taskType === 'file' && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Select File</label>
                    <input 
                      type="file" 
                      ref={fileInputRef} 
                      onChange={handleFileChange} 
                      className="hidden" 
                    />
                    <div 
                      onClick={() => fileInputRef.current?.click()}
                      className="w-full bg-gray-50 dark:bg-gray-800 border-2 border-dashed border-gray-200 dark:border-gray-700 hover:border-teal-400 dark:hover:border-teal-500 hover:bg-teal-50 dark:hover:bg-gray-800/80 rounded-2xl p-8 flex flex-col items-center justify-center transition-all cursor-pointer mb-4"
                    >
                      <div className="w-12 h-12 bg-white dark:bg-gray-700 rounded-full shadow-sm flex items-center justify-center mb-3 text-teal-600 dark:text-teal-400">
                        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/></svg>
                      </div>
                      <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
                        {selectedFile ? selectedFile.name : 'Click to browse or drag file here'}
                      </p>
                      {!selectedFile && <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Any file type supported</p>}
                    </div>

                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Instructions (Optional)</label>
                    <textarea
                      value={payload}
                      onChange={e => setPayload(e.target.value)}
                      placeholder="What should the device do with this file?"
                      className="w-full bg-gray-50 dark:bg-gray-800 border-transparent text-gray-900 dark:text-white focus:bg-white dark:focus:bg-gray-800 focus:border-teal-500 focus:ring-2 focus:ring-teal-200 dark:focus:ring-teal-500/50 rounded-2xl p-4 min-h-[80px] transition-all resize-none outline-none placeholder-gray-400 dark:placeholder-gray-500"
                    />
                  </div>
                )}

                <button 
                  onClick={handleSend}
                  disabled={taskType === 'file' ? !selectedFile : !payload.trim()}
                  className="w-full bg-teal-600 hover:bg-teal-700 dark:hover:bg-teal-500 disabled:bg-gray-200 dark:disabled:bg-gray-800 disabled:text-gray-400 dark:disabled:text-gray-500 disabled:cursor-not-allowed text-white font-medium py-4 rounded-2xl flex items-center justify-center gap-2 transition-colors mt-4"
                >
                  <Send className="w-5 h-5" />
                  {taskType === 'file' ? (selectedFile ? `Send ${selectedFile.name}` : 'Send File') : 'Send Task'}
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
