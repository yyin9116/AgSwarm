import { CheckCircle2, Clock, XCircle, FileText, MessageSquare, Monitor, FileUp, ArrowDownLeft, ArrowUpRight, ChevronDown, ChevronUp, Download, Image as ImageIcon } from 'lucide-react';
import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';

export interface Task {
  id: string;
  type: 'Echo' | 'LaTeX' | 'Agent' | 'File';
  target: string;
  direction: 'incoming' | 'outgoing';
  status: 'completed' | 'running' | 'failed';
  time: string;
  detail: string;
  result?: string;
  filePreview?: {
    type: 'image' | 'pdf';
    url: string;
    name: string;
  };
}

interface TasksViewProps {
  tasks: Task[];
}

export function TasksView({ tasks }: TasksViewProps) {
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);

  const toggleExpand = (id: string) => {
    setExpandedTaskId(prev => prev === id ? null : id);
  };

  return (
    <div className="p-6 max-w-3xl mx-auto pt-12">
      <h1 className="text-3xl font-semibold tracking-tight mb-8 dark:text-white">Activity</h1>
      
      <div className="space-y-3">
        {tasks.map(task => {
          const isExpanded = expandedTaskId === task.id;
          return (
            <div 
              key={task.id} 
              className={`bg-white dark:bg-gray-900 rounded-2xl shadow-sm border transition-colors cursor-pointer ${
                isExpanded ? 'border-teal-200 dark:border-teal-800/50' : 'border-gray-100 dark:border-gray-800 hover:border-gray-200 dark:hover:border-gray-700'
              }`}
              onClick={() => toggleExpand(task.id)}
            >
              <div className="p-4 flex items-center gap-4">
                <div className="relative">
                  <div className={`flex items-center justify-center w-10 h-10 rounded-full ${
                    task.status === 'completed' ? 'bg-green-50 text-green-600 dark:bg-green-900/30 dark:text-green-400' :
                    task.status === 'running' ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400' :
                    'bg-red-50 text-red-600 dark:bg-red-900/30 dark:text-red-400'
                  }`}>
                    {task.type === 'Echo' && <MessageSquare className="w-5 h-5" />}
                    {task.type === 'LaTeX' && <FileText className="w-5 h-5" />}
                    {task.type === 'Agent' && <Monitor className="w-5 h-5" />}
                    {task.type === 'File' && <FileUp className="w-5 h-5" />}
                  </div>
                  <div className={`absolute -bottom-1 -right-1 w-4 h-4 rounded-full flex items-center justify-center border-2 border-white dark:border-gray-900 ${
                    task.direction === 'incoming' ? 'bg-indigo-500' : 'bg-teal-500'
                  }`}>
                    {task.direction === 'incoming' ? (
                      <ArrowDownLeft className="w-2.5 h-2.5 text-white" />
                    ) : (
                      <ArrowUpRight className="w-2.5 h-2.5 text-white" />
                    )}
                  </div>
                </div>
                
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <h4 className="text-base font-medium text-gray-900 dark:text-gray-100 truncate">
                      {task.type} {task.direction === 'incoming' ? 'from' : 'to'} {task.target}
                    </h4>
                    <span className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap ml-2">{task.time}</span>
                  </div>
                  <p className="text-sm text-gray-500 dark:text-gray-400 truncate mt-0.5">{task.detail}</p>
                </div>
                
                <div className="flex items-center gap-3">
                  {task.status === 'completed' && <CheckCircle2 className="w-5 h-5 text-green-500 dark:text-green-400" />}
                  {task.status === 'running' && <Clock className="w-5 h-5 text-blue-500 dark:text-blue-400 animate-pulse" />}
                  {task.status === 'failed' && <XCircle className="w-5 h-5 text-red-500 dark:text-red-400" />}
                  {isExpanded ? (
                    <ChevronUp className="w-4 h-4 text-gray-400 dark:text-gray-500" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-gray-400 dark:text-gray-500" />
                  )}
                </div>
              </div>

              <AnimatePresence>
                {isExpanded && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="overflow-hidden"
                  >
                    <div className="px-4 pb-4 pt-2 border-t border-gray-100 dark:border-gray-800">
                      <div className="bg-gray-50 dark:bg-gray-800/50 rounded-xl p-4 space-y-3">
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <span className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Task ID</span>
                            <span className="block text-sm font-mono text-gray-900 dark:text-gray-200">{task.id}</span>
                          </div>
                          <div>
                            <span className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Status</span>
                            <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium capitalize ${
                              task.status === 'completed' ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400' :
                              task.status === 'running' ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400' :
                              'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400'
                            }`}>
                              {task.status}
                            </span>
                          </div>
                        </div>
                        
                        <div>
                          <span className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Payload / Detail</span>
                          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg p-3 text-sm text-gray-700 dark:text-gray-300 font-mono whitespace-pre-wrap">
                            {task.detail}
                          </div>
                        </div>

                        {task.status === 'completed' && (
                          <div>
                            <span className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Result</span>
                            <div className="bg-green-50 dark:bg-green-900/20 border border-green-100 dark:border-green-800/50 rounded-lg p-3 text-sm text-green-800 dark:text-green-400 font-mono">
                              {task.result || 'Task execution completed successfully.'}
                            </div>
                            
                            {task.filePreview && (
                              <div className="mt-3 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden bg-white dark:bg-gray-900 shadow-sm">
                                {task.filePreview.type === 'image' ? (
                                  <div className="relative group">
                                    <img 
                                      src={task.filePreview.url} 
                                      alt={task.filePreview.name}
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
                                        <ImageIcon className="w-3 h-3" /> {task.filePreview.name}
                                      </p>
                                    </div>
                                  </div>
                                ) : (
                                  <div className="flex items-center gap-3 p-3 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors cursor-pointer">
                                    <div className="w-10 h-10 bg-red-50 dark:bg-red-900/20 text-red-500 dark:text-red-400 rounded-lg flex items-center justify-center flex-shrink-0">
                                      <FileText className="w-5 h-5" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{task.filePreview.name}</p>
                                      <p className="text-xs text-gray-500 dark:text-gray-400">PDF Document</p>
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
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>
    </div>
  );
}
