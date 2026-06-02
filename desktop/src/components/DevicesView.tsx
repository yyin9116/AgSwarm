import React, { useState, useMemo, useEffect } from 'react';
import { Monitor, Smartphone, Laptop, Radar, Loader2, Plus, Search, FileUp, CheckCircle2, XCircle, X, RefreshCw, FileArchive, FileText, Image as ImageIcon, FileCode, FileAudio, FileVideo, File } from 'lucide-react';
import { ConnectModal } from './ConnectModal';
import { DeviceDetailsModal } from './DeviceDetailsModal';
import { motion, AnimatePresence } from 'motion/react';

export interface Device {
  id: string;
  name: string;
  type: 'laptop' | 'desktop' | 'mobile';
  os: string;
  status: 'online' | 'offline' | 'transferring' | 'idle';
  ipAddress?: string;
  storage?: string;
  networkType?: 'Wi-Fi' | 'Bluetooth' | 'Ethernet';
  backgroundTasks?: string[];
  activeTask?: {
    type: string;
    status: 'receiving' | 'executing';
  } | null;
}

export interface FileTransfer {
  id: string;
  fileName: string;
  targetDeviceName: string;
  progress: number;
  status: 'pending' | 'transferring' | 'completed' | 'failed';
  size: string;
}

interface DevicesViewProps {
  devices: Device[];
  transfers?: FileTransfer[];
  onSelectDevice: (device: Device, file?: File) => void;
  onAddDevice: (device: Device) => void;
  onCancelTransfer?: (transferId: string) => void;
}

export function DevicesView({ devices, transfers = [], onSelectDevice, onAddDevice, onCancelTransfer }: DevicesViewProps) {
  const [isConnectModalOpen, setIsConnectModalOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedDeviceDetails, setSelectedDeviceDetails] = useState<Device | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [prevTransfersCount, setPrevTransfersCount] = useState(transfers.length);
  const [dragOverDevice, setDragOverDevice] = useState<string | null>(null);

  useEffect(() => {
    if (transfers.length > prevTransfersCount) {
      const newTransfer = transfers[0]; // Assuming new transfers are added to the top
      if (newTransfer && (newTransfer.status === 'pending' || newTransfer.status === 'transferring')) {
        setToastMessage(`New file transfer initiated: ${newTransfer.fileName}`);
        const timer = setTimeout(() => setToastMessage(null), 5000);
        return () => clearTimeout(timer);
      }
    }
    setPrevTransfersCount(transfers.length);
  }, [transfers, prevTransfersCount]);

  const handleDragOver = (e: React.DragEvent, deviceId: string) => {
    e.preventDefault();
    setDragOverDevice(deviceId);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOverDevice(null);
  };

  const handleDrop = (e: React.DragEvent, device: Device) => {
    e.preventDefault();
    setDragOverDevice(null);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      onSelectDevice(device, file);
    }
  };

  const filteredDevices = useMemo(() => {
    return devices.filter(d => 
      d.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
      (d.ipAddress && d.ipAddress.includes(searchQuery))
    );
  }, [devices, searchQuery]);

  const getFileIcon = (fileName: string) => {
    const ext = fileName.split('.').pop()?.toLowerCase() || '';
    switch (ext) {
      case 'zip':
      case 'rar':
      case 'tar':
      case 'gz':
        return <FileArchive className="w-5 h-5" />;
      case 'pdf':
      case 'txt':
      case 'md':
      case 'doc':
      case 'docx':
        return <FileText className="w-5 h-5" />;
      case 'png':
      case 'jpg':
      case 'jpeg':
      case 'gif':
      case 'svg':
        return <ImageIcon className="w-5 h-5" />;
      case 'js':
      case 'ts':
      case 'jsx':
      case 'tsx':
      case 'html':
      case 'css':
      case 'json':
        return <FileCode className="w-5 h-5" />;
      case 'mp3':
      case 'wav':
      case 'ogg':
        return <FileAudio className="w-5 h-5" />;
      case 'mp4':
      case 'mov':
      case 'avi':
      case 'mkv':
        return <FileVideo className="w-5 h-5" />;
      default:
        return <File className="w-5 h-5" />;
    }
  };

  return (
    <div className="p-6 max-w-3xl mx-auto pt-12 relative">
      <AnimatePresence>
        {toastMessage && (
          <motion.div
            initial={{ opacity: 0, y: -50 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -50 }}
            className="fixed top-6 left-1/2 -translate-x-1/2 z-50 bg-gray-900 dark:bg-white text-white dark:text-gray-900 px-6 py-3 rounded-full shadow-lg flex items-center gap-3"
          >
            <FileUp className="w-4 h-4" />
            <span className="text-sm font-medium">{toastMessage}</span>
            <button onClick={() => setToastMessage(null)} className="ml-2 opacity-70 hover:opacity-100">
              <X className="w-4 h-4" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight dark:text-white">Nearby Devices</h1>
          <p className="text-gray-500 dark:text-gray-400 mt-1">Select a device to send tasks or files.</p>
        </div>
        <button 
          onClick={() => setIsConnectModalOpen(true)}
          className="flex items-center gap-2 px-4 py-2 bg-teal-50 dark:bg-teal-900/30 text-teal-600 dark:text-teal-400 rounded-full hover:bg-teal-100 dark:hover:bg-teal-900/50 transition-colors font-medium text-sm border border-teal-100 dark:border-teal-800/50"
        >
          <Plus className="w-4 h-4" />
          Add Device
        </button>
      </div>

      {/* Search Bar */}
      <div className="relative mb-8">
        <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
          <Search className="h-5 w-5 text-gray-400" />
        </div>
        <input
          type="text"
          className="block w-full pl-11 pr-4 py-3 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20 focus:border-teal-500 transition-all dark:text-white"
          placeholder="Search devices by name or IP address..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-10">
        {filteredDevices.map(device => (
          <div 
            key={device.id} 
            onClick={() => setSelectedDeviceDetails(device)}
            onDragOver={(e) => handleDragOver(e, device.id)}
            onDragLeave={handleDragLeave}
            onDrop={(e) => handleDrop(e, device)}
            className={`group relative bg-white dark:bg-gray-900 p-5 rounded-3xl shadow-sm border transition-all cursor-pointer overflow-hidden ${
              dragOverDevice === device.id ? 'border-teal-500 bg-teal-50 dark:bg-teal-900/20 shadow-lg scale-[1.02]' :
              device.activeTask ? 'border-teal-400 dark:border-teal-600 shadow-teal-100/50 dark:shadow-teal-900/20' : 'border-gray-100 dark:border-gray-800 hover:shadow-md hover:border-teal-100 dark:hover:border-teal-800/50'
            }`}
          >
            {dragOverDevice === device.id && (
              <div className="absolute inset-0 bg-teal-500/10 dark:bg-teal-500/20 z-0 pointer-events-none flex items-center justify-center">
                <div className="bg-teal-600 text-white px-4 py-2 rounded-full text-sm font-medium shadow-lg flex items-center gap-2">
                  <FileUp className="w-4 h-4" /> Drop to send file
                </div>
              </div>
            )}
            {device.activeTask && (
              <div className="absolute inset-0 bg-teal-50/30 dark:bg-teal-900/10 animate-pulse pointer-events-none" />
            )}
            <div className="flex items-start justify-between relative z-10">
              <div className={`flex items-center justify-center w-12 h-12 rounded-2xl transition-colors ${
                device.activeTask ? 'bg-teal-100 dark:bg-teal-900/30 text-teal-600 dark:text-teal-400' : 'bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-300 group-hover:bg-teal-50 dark:group-hover:bg-teal-900/20 group-hover:text-teal-600 dark:group-hover:text-teal-400'
              }`}>
                {device.type === 'laptop' && <Laptop className="w-6 h-6" />}
                {device.type === 'desktop' && <Monitor className="w-6 h-6" />}
                {device.type === 'mobile' && <Smartphone className="w-6 h-6" />}
              </div>
              <div className="flex items-center gap-2 bg-gray-50/50 dark:bg-gray-800/50 px-2.5 py-1 rounded-full border border-gray-100 dark:border-gray-800">
                <div className="relative flex items-center justify-center">
                  {(device.status === 'online' || device.status === 'transferring') && (
                    <div className={`absolute w-2 h-2 rounded-full animate-ping opacity-75 ${device.status === 'transferring' ? 'bg-blue-400 dark:bg-blue-500' : 'bg-green-400 dark:bg-green-500'}`} />
                  )}
                  <div className={`relative w-2 h-2 rounded-full ${
                    device.status === 'online' ? 'bg-green-500' : 
                    device.status === 'idle' ? 'bg-yellow-500' :
                    device.status === 'transferring' ? 'bg-blue-500' :
                    'bg-gray-300 dark:bg-gray-600'
                  }`} />
                </div>
                <span className={`flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider ${
                  device.status === 'online' ? 'text-green-600 dark:text-green-400' :
                  device.status === 'idle' ? 'text-yellow-600 dark:text-yellow-400' :
                  device.status === 'transferring' ? 'text-blue-600 dark:text-blue-400' :
                  'text-gray-500 dark:text-gray-400'
                }`}>
                  {device.status}
                  {device.status === 'transferring' && <RefreshCw className="w-3 h-3 animate-spin" />}
                </span>
              </div>
            </div>
            <div className="mt-4 relative z-10">
              <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">{device.name}</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400 font-mono mt-0.5">{device.ipAddress || device.id}</p>
            </div>
            
            {/* Auto-accepting task UI */}
            {device.activeTask && (
              <div className="mt-4 bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm border border-teal-100 dark:border-teal-800/50 rounded-xl p-3 flex items-center gap-3 relative z-10">
                <Loader2 className="w-4 h-4 text-teal-600 dark:text-teal-400 animate-spin" />
                <div className="flex-1">
                  <p className="text-xs font-medium text-teal-900 dark:text-teal-300">
                    {device.activeTask.status === 'receiving' ? 'Receiving task...' : `Executing ${device.activeTask.type}...`}
                  </p>
                </div>
              </div>
            )}
          </div>
        ))}
        {filteredDevices.length === 0 && (
          <div className="col-span-full py-12 text-center text-gray-500 dark:text-gray-400">
            No devices found matching "{searchQuery}"
          </div>
        )}
      </div>

      {/* File Transfer Queue */}
      {transfers.length > 0 && (
        <div className="mb-10">
          <h2 className="text-xl font-semibold tracking-tight dark:text-white mb-4">Transfer Queue</h2>
          <div className="space-y-3">
            {transfers.map(transfer => (
              <div key={transfer.id} className="bg-white dark:bg-gray-900 p-4 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm flex items-center gap-4">
                <div className={`p-2 rounded-xl ${
                  transfer.status === 'completed' ? 'bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400' :
                  transfer.status === 'failed' ? 'bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400' :
                  'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400'
                }`}>
                  {transfer.status === 'completed' ? <CheckCircle2 className="w-5 h-5" /> :
                   transfer.status === 'failed' ? <XCircle className="w-5 h-5" /> :
                   getFileIcon(transfer.fileName)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-sm font-medium text-gray-900 dark:text-white truncate">{transfer.fileName}</p>
                    <span className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap ml-2">{transfer.size}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400 mb-2">
                    <span>To: {transfer.targetDeviceName}</span>
                    <div className="flex items-center gap-2">
                      <span className="capitalize">{transfer.status}</span>
                      {(transfer.status === 'pending' || transfer.status === 'transferring') && onCancelTransfer && (
                        <button 
                          onClick={() => onCancelTransfer(transfer.id)}
                          className="text-red-500 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300 transition-colors"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  </div>
                  {/* Progress Bar */}
                  <div className="h-1.5 w-full bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                    <div 
                      className={`h-full rounded-full transition-all duration-500 ${
                        transfer.status === 'completed' ? 'bg-green-500' :
                        transfer.status === 'failed' ? 'bg-red-500' :
                        'bg-blue-500'
                      }`}
                      style={{ width: `${transfer.progress}%` }}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <ConnectModal 
        isOpen={isConnectModalOpen}
        onClose={() => setIsConnectModalOpen(false)}
        onConnect={onAddDevice}
      />

      <DeviceDetailsModal
        device={selectedDeviceDetails}
        onClose={() => setSelectedDeviceDetails(null)}
        onSendTask={(device) => {
          setSelectedDeviceDetails(null);
          onSelectDevice(device);
        }}
      />
    </div>
  );
}
