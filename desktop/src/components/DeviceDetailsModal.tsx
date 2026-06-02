import { X, HardDrive, Network, Activity, Laptop, Monitor, Smartphone, Wifi, Bluetooth, Cable, Layers } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Device } from './DevicesView';

interface DeviceDetailsModalProps {
  device: Device | null;
  onClose: () => void;
  onSendTask?: (device: Device) => void;
}

export function DeviceDetailsModal({ device, onClose, onSendTask }: DeviceDetailsModalProps) {
  if (!device) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          className="bg-white dark:bg-gray-900 rounded-3xl shadow-xl w-full max-w-md overflow-hidden border border-gray-100 dark:border-gray-800"
        >
          {/* Header */}
          <div className="flex items-center justify-between p-6 border-b border-gray-100 dark:border-gray-800">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Device Details</h2>
            <button onClick={onClose} className="p-2 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Content */}
          <div className="p-6 space-y-6">
            <div className="flex items-center gap-4">
              <div className="w-16 h-16 rounded-2xl bg-teal-50 dark:bg-teal-900/30 text-teal-600 dark:text-teal-400 flex items-center justify-center">
                {device.type === 'laptop' && <Laptop className="w-8 h-8" />}
                {device.type === 'desktop' && <Monitor className="w-8 h-8" />}
                {device.type === 'mobile' && <Smartphone className="w-8 h-8" />}
              </div>
              <div>
                <h3 className="text-xl font-semibold text-gray-900 dark:text-white">{device.name}</h3>
                <p className="text-sm text-gray-500 dark:text-gray-400">{device.os}</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="bg-gray-50 dark:bg-gray-800/50 p-4 rounded-2xl border border-gray-100 dark:border-gray-800">
                <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400 mb-2">
                  <Network className="w-4 h-4" />
                  <span className="text-xs font-medium uppercase tracking-wider">IP Address</span>
                </div>
                <p className="text-sm font-mono text-gray-900 dark:text-gray-100">{device.ipAddress || 'Unknown'}</p>
              </div>
              <div className="bg-gray-50 dark:bg-gray-800/50 p-4 rounded-2xl border border-gray-100 dark:border-gray-800">
                <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400 mb-2">
                  <HardDrive className="w-4 h-4" />
                  <span className="text-xs font-medium uppercase tracking-wider">Storage</span>
                </div>
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{device.storage || 'Unknown'}</p>
              </div>
              
              <div className="bg-gray-50 dark:bg-gray-800/50 p-4 rounded-2xl border border-gray-100 dark:border-gray-800">
                <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400 mb-2">
                  <Activity className="w-4 h-4" />
                  <span className="text-xs font-medium uppercase tracking-wider">AgSwarm Status</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className={`w-2.5 h-2.5 rounded-full ${
                    device.status === 'online' ? 'bg-green-500' : 
                    device.status === 'idle' ? 'bg-yellow-500' :
                    device.status === 'transferring' ? 'bg-blue-500' :
                    'bg-gray-400'
                  }`} />
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100 capitalize">{device.status}</p>
                </div>
              </div>

              <div className="bg-gray-50 dark:bg-gray-800/50 p-4 rounded-2xl border border-gray-100 dark:border-gray-800">
                <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400 mb-2">
                  {device.networkType === 'Wi-Fi' ? <Wifi className="w-4 h-4" /> :
                   device.networkType === 'Bluetooth' ? <Bluetooth className="w-4 h-4" /> :
                   <Cable className="w-4 h-4" />}
                  <span className="text-xs font-medium uppercase tracking-wider">Network</span>
                </div>
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{device.networkType || 'Unknown'}</p>
              </div>

              {device.backgroundTasks && device.backgroundTasks.length > 0 && (
                <div className="bg-gray-50 dark:bg-gray-800/50 p-4 rounded-2xl border border-gray-100 dark:border-gray-800 col-span-2">
                  <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400 mb-2">
                    <Layers className="w-4 h-4" />
                    <span className="text-xs font-medium uppercase tracking-wider">Background Tasks</span>
                  </div>
                  <ul className="space-y-1">
                    {device.backgroundTasks.map((task, idx) => (
                      <li key={idx} className="text-sm text-gray-700 dark:text-gray-300 flex items-center gap-2">
                        <div className="w-1.5 h-1.5 rounded-full bg-gray-400 dark:bg-gray-500" />
                        {task}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              
              {device.activeTask && (
                <div className="bg-teal-50 dark:bg-teal-900/20 p-4 rounded-2xl border border-teal-100 dark:border-teal-800/50 col-span-2">
                  <div className="flex items-center gap-2 text-teal-600 dark:text-teal-400 mb-2">
                    <Activity className="w-4 h-4" />
                    <span className="text-xs font-medium uppercase tracking-wider">Active Task</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium text-teal-900 dark:text-teal-100">{device.activeTask.type}</p>
                    <span className="text-xs bg-teal-100 dark:bg-teal-800/50 text-teal-700 dark:text-teal-300 px-2 py-1 rounded-full capitalize">
                      {device.activeTask.status}
                    </span>
                  </div>
                </div>
              )}
            </div>

            <div className="pt-4 flex gap-3">
              <button 
                onClick={onClose}
                className="flex-1 px-4 py-2.5 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-xl hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors font-medium text-sm"
              >
                Close
              </button>
              <button 
                onClick={() => onSendTask && onSendTask(device)}
                className="flex-1 px-4 py-2.5 bg-teal-600 text-white rounded-xl hover:bg-teal-700 transition-colors font-medium text-sm shadow-sm shadow-teal-600/20"
              >
                Send Task
              </button>
            </div>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
