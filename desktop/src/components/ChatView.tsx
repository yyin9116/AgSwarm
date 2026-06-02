import React, { useState, useRef, useEffect } from 'react';
import { Send, Bot, User, Sparkles, CheckCircle2, Loader2, ArrowRight, Monitor, Laptop, Smartphone, ArrowDownLeft, ArrowUpRight, FileText, Download, Image as ImageIcon, Paperclip, X } from 'lucide-react';
import { AppIcon } from './AppIcon';

export interface ChatMessage {
  id: string;
  role: 'user' | 'agent' | 'system';
  content: string;
  isThinking?: boolean;
  followUpOptions?: string[];
  attachment?: {
    name: string;
    size: string;
  };
  taskProposal?: {
    direction: 'incoming' | 'outgoing';
    targetDeviceId: string;
    targetDeviceName: string;
    taskType: string;
    payload: string;
    status: 'parsing' | 'created' | 'dispatching' | 'accepted' | 'running' | 'completed';
    result?: string;
    preview?: {
      type: 'image' | 'pdf';
      url: string;
      name: string;
    };
  };
}

interface ChatViewProps {
  messages: ChatMessage[];
  onSendMessage: (content: string, file?: File) => void;
}

function ThinkingIndicator() {
  const [dots, setDots] = useState('');
  const [messageIndex, setMessageIndex] = useState(0);
  const messages = ['Analyzing request', 'Locating device', 'Preparing payload', 'Establishing connection'];

  useEffect(() => {
    const interval = setInterval(() => {
      setDots(prev => prev.length >= 3 ? '' : prev + '.');
    }, 500);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      setMessageIndex(prev => (prev + 1) % messages.length);
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
      <Loader2 className="w-4 h-4 animate-spin" />
      <span className="text-sm font-medium">{messages[messageIndex]}{dots}</span>
    </div>
  );
}

export function ChatView({ messages, onSendMessage }: ChatViewProps) {
  const [input, setInput] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSend = () => {
    if (!input.trim() && !selectedFile) return;
    onSendMessage(input, selectedFile || undefined);
    setInput('');
    setSelectedFile(null);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setSelectedFile(e.target.files[0]);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'parsing':
      case 'created':
      case 'dispatching':
      case 'accepted':
      case 'running':
        return <span className="flex items-center gap-1 text-xs font-medium text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full"><Loader2 className="w-3 h-3 animate-spin"/> {status.charAt(0).toUpperCase() + status.slice(1)}</span>;
      case 'completed':
        return <span className="flex items-center gap-1 text-xs font-medium text-green-600 bg-green-50 px-2 py-0.5 rounded-full"><CheckCircle2 className="w-3 h-3"/> Completed</span>;
      default:
        return null;
    }
  };

  return (
    <div className="flex flex-col h-full max-w-3xl mx-auto pt-8 pb-4 px-4 sm:px-6">
      <div className="flex items-center gap-3 mb-6 px-2">
        <div className="w-10 h-10 rounded-full flex items-center justify-center">
          <AppIcon className="w-10 h-10" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight dark:text-white">Agent Copilot</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">Ask me to orchestrate tasks across your devices.</p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto space-y-6 px-2 pb-6 scrollbar-hide">
        {messages.map((msg) => (
          <div key={msg.id} className={`flex gap-4 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
            <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center mt-1 ${
              msg.role === 'user' ? 'bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900' : 
              msg.role === 'system' ? 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 border border-indigo-100 dark:border-indigo-800/50' :
              ''
            }`}>
              {msg.role === 'user' ? <User className="w-4 h-4" /> : 
               msg.role === 'system' ? <ArrowDownLeft className="w-4 h-4" /> : 
               <AppIcon className="w-8 h-8" />}
            </div>
            
            <div className={`flex flex-col max-w-[85%] ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
              {msg.attachment && (
                <div className="mb-2 flex items-center gap-3 p-2.5 bg-gray-50 dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 w-fit max-w-full">
                  <div className="w-8 h-8 bg-teal-100 dark:bg-teal-900/30 text-teal-600 dark:text-teal-400 rounded-lg flex items-center justify-center flex-shrink-0">
                    <FileText className="w-4 h-4" />
                  </div>
                  <div className="flex-1 min-w-0 pr-2">
                    <p className="text-xs font-medium text-gray-900 dark:text-white truncate">{msg.attachment.name}</p>
                    <p className="text-[10px] text-gray-500 dark:text-gray-400">{msg.attachment.size}</p>
                  </div>
                </div>
              )}
              <div className={`px-4 py-3 rounded-2xl ${
                msg.role === 'user' 
                  ? 'bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 rounded-tr-sm' 
                  : msg.role === 'system'
                  ? 'bg-indigo-50/50 dark:bg-indigo-900/20 border border-indigo-100 dark:border-indigo-800/50 text-indigo-900 dark:text-indigo-300 rounded-tl-sm'
                  : 'bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm rounded-tl-sm text-gray-800 dark:text-gray-200'
              }`}>
                {msg.isThinking ? (
                  <ThinkingIndicator />
                ) : (
                  <p className="text-sm leading-relaxed whitespace-pre-wrap">{msg.content}</p>
                )}
              </div>

              {/* Agent Task Proposal Card */}
              {msg.taskProposal && (
                <div className={`mt-3 w-full max-w-sm bg-white dark:bg-gray-900 border rounded-2xl shadow-sm overflow-hidden ${
                  msg.taskProposal.direction === 'incoming' ? 'border-indigo-100 dark:border-indigo-800/50' : 'border-gray-100 dark:border-gray-800'
                }`}>
                  <div className={`px-4 py-2 border-b flex items-center justify-between ${
                    msg.taskProposal.direction === 'incoming' ? 'bg-indigo-50/50 dark:bg-indigo-900/20 border-indigo-100 dark:border-indigo-800/50' : 'bg-gray-50/50 dark:bg-gray-800/50 border-gray-100 dark:border-gray-800'
                  }`}>
                    <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      {msg.taskProposal.direction === 'incoming' ? 'Incoming Task' : 'Task Execution'}
                    </span>
                    {getStatusBadge(msg.taskProposal.status)}
                  </div>
                  <div className="p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                          msg.taskProposal.direction === 'incoming' ? 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400' : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'
                        }`}>
                          {msg.taskProposal.direction === 'incoming' ? <Monitor className="w-4 h-4" /> : <AppIcon className="w-4 h-4" />}
                        </div>
                        {msg.taskProposal.direction === 'incoming' ? (
                          <ArrowDownLeft className="w-4 h-4 text-indigo-300 dark:text-indigo-700" />
                        ) : (
                          <ArrowRight className="w-4 h-4 text-gray-300 dark:text-gray-700" />
                        )}
                        <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                          msg.taskProposal.direction === 'incoming' ? 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400' : 'bg-teal-50 dark:bg-teal-900/30 text-teal-600 dark:text-teal-400'
                        }`}>
                          {msg.taskProposal.direction === 'incoming' ? <AppIcon className="w-4 h-4" /> : <Laptop className="w-4 h-4" />}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{msg.taskProposal.targetDeviceName}</div>
                        <div className="text-xs text-gray-500 dark:text-gray-400 font-mono">{msg.taskProposal.targetDeviceId}</div>
                      </div>
                    </div>
                    
                    <div className="bg-gray-50 dark:bg-gray-800/50 rounded-xl p-3">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Action</span>
                        <span className="text-xs font-semibold text-gray-900 dark:text-gray-100">{msg.taskProposal.taskType}</span>
                      </div>
                      <p className="text-xs text-gray-600 dark:text-gray-400 font-mono truncate">{msg.taskProposal.payload}</p>
                    </div>

                    {msg.taskProposal.result && (
                      <div className="bg-green-50 dark:bg-green-900/20 border border-green-100 dark:border-green-800/50 rounded-xl p-3 mt-2">
                        <div className="flex items-center gap-1.5 mb-1">
                          <CheckCircle2 className="w-3.5 h-3.5 text-green-600 dark:text-green-400" />
                          <span className="text-xs font-medium text-green-800 dark:text-green-400">Result</span>
                        </div>
                        <p className="text-xs text-green-700 dark:text-green-500 font-mono truncate">{msg.taskProposal.result}</p>
                        
                        {/* File Preview Section */}
                        {msg.taskProposal.preview && (
                          <div className="mt-3 border border-green-200/60 dark:border-green-800/50 rounded-lg overflow-hidden bg-white dark:bg-gray-900 shadow-sm">
                            {msg.taskProposal.preview.type === 'image' ? (
                              <div className="relative group">
                                <img 
                                  src={msg.taskProposal.preview.url} 
                                  alt={msg.taskProposal.preview.name}
                                  className="w-full h-auto max-h-48 object-cover"
                                  referrerPolicy="no-referrer"
                                />
                                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                  <button className="bg-white/90 dark:bg-gray-800/90 text-gray-900 dark:text-white p-2 rounded-full shadow-sm hover:scale-105 transition-transform">
                                    <Download className="w-4 h-4" />
                                  </button>
                                </div>
                                <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent p-2">
                                  <p className="text-xs text-white font-medium truncate flex items-center gap-1">
                                    <ImageIcon className="w-3 h-3" /> {msg.taskProposal.preview.name}
                                  </p>
                                </div>
                              </div>
                            ) : (
                              <div className="flex items-center gap-3 p-3 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors cursor-pointer">
                                <div className="w-10 h-10 bg-red-50 dark:bg-red-900/20 text-red-500 dark:text-red-400 rounded-lg flex items-center justify-center flex-shrink-0">
                                  <FileText className="w-5 h-5" />
                                </div>
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{msg.taskProposal.preview.name}</p>
                                  <p className="text-xs text-gray-500 dark:text-gray-400">PDF Document • 1.2 MB</p>
                                </div>
                                <button className="text-gray-400 hover:text-teal-600 dark:hover:text-teal-400 p-2 transition-colors">
                                  <Download className="w-5 h-5" />
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Follow-up Options */}
              {msg.followUpOptions && msg.taskProposal?.status === 'completed' && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {msg.followUpOptions.map((option, idx) => (
                    <button
                      key={idx}
                      onClick={() => onSendMessage(option)}
                      className="text-xs font-medium px-3 py-1.5 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 rounded-full hover:bg-gray-50 dark:hover:bg-gray-800 hover:border-gray-300 dark:hover:border-gray-600 transition-colors shadow-sm"
                    >
                      {option}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      <div className="relative mt-auto mb-8">
        {selectedFile && (
          <div className="absolute -top-12 left-0 right-0 flex items-center gap-2 p-2 bg-gray-50 dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm mx-2">
            <div className="w-8 h-8 bg-teal-100 dark:bg-teal-900/30 text-teal-600 dark:text-teal-400 rounded-lg flex items-center justify-center">
              <FileText className="w-4 h-4" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-gray-900 dark:text-white truncate">{selectedFile.name}</p>
              <p className="text-[10px] text-gray-500 dark:text-gray-400">{(selectedFile.size / 1024).toFixed(1)} KB</p>
            </div>
            <button 
              onClick={() => setSelectedFile(null)}
              className="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}
        <div className="relative flex items-center">
          <button
            onClick={() => fileInputRef.current?.click()}
            className="absolute left-3 p-2 text-gray-400 hover:text-teal-600 dark:hover:text-teal-400 transition-colors"
          >
            <Paperclip className="w-5 h-5" />
          </button>
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileChange}
            className="hidden"
          />
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            placeholder="e.g., Send a latex file to my Mac..."
            className="w-full bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 focus:border-teal-500 focus:ring-2 focus:ring-teal-200 dark:focus:ring-teal-900/50 rounded-2xl py-4 pl-12 pr-14 shadow-sm transition-all outline-none dark:text-white dark:placeholder-gray-500"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() && !selectedFile}
            className="absolute right-2 w-10 h-10 bg-teal-600 hover:bg-teal-700 disabled:bg-gray-200 dark:disabled:bg-gray-800 disabled:text-gray-400 dark:disabled:text-gray-600 text-white rounded-xl flex items-center justify-center transition-colors"
          >
            <Send className="w-4 h-4 ml-0.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
