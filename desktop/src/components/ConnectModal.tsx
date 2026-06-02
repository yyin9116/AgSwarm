import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Radar, Smartphone, Laptop, Monitor, CheckCircle2, Loader2, Wifi, Bluetooth } from 'lucide-react';
import { Device } from './DevicesView';

interface ConnectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConnect: (device: Device) => void;
}

const MOCK_DISCOVERED_DEVICES: Device[] = [
  { id: 'node-d', name: 'iPad Pro', type: 'mobile', os: 'iPadOS', status: 'online' },
  { id: 'node-e', name: 'Linux Workstation', type: 'desktop', os: 'Ubuntu', status: 'online' },
  { id: 'node-f', name: 'Living Room TV', type: 'desktop', os: 'Android TV', status: 'online' },
];

export function ConnectModal({ isOpen, onClose, onConnect }: ConnectModalProps) {
  const [isScanning, setIsScanning] = useState(true);
  const [discoveredDevices, setDiscoveredDevices] = useState<Device[]>([]);
  const [connectingTo, setConnectingTo] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setIsScanning(true);
      setDiscoveredDevices([]);
      setConnectingTo(null);

      // Simulate discovering devices over time
      const timers = MOCK_DISCOVERED_DEVICES.map((device, index) => {
        return setTimeout(() => {
          setDiscoveredDevices(prev => [...prev, device]);
        }, 1500 + index * 1200);
      });

      const stopScanTimer = setTimeout(() => {
        setIsScanning(false);
      }, 6000);

      return () => {
        timers.forEach(clearTimeout);
        clearTimeout(stopScanTimer);
      };
    }
  }, [isOpen]);

  const handleConnect = (device: Device) => {
    setConnectingTo(device.id);
    // Simulate connection delay
    setTimeout(() => {
      onConnect(device);
      setConnectingTo(null);
      onClose();
    }, 1500);
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-gray-900/40 dark:bg-black/60 backdrop-blur-sm"
          />
          
          <motion.div 
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            className="relative w-full max-w-md bg-white dark:bg-gray-900 rounded-[2rem] shadow-2xl overflow-hidden border border-gray-100 dark:border-gray-800 flex flex-col max-h-[85vh]"
          >
            {/* Header */}
          <div className="flex items-center justify-between p-6 pb-4 border-b border-gray-100 dark:border-gray-800">
            <div>
              <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Add Device</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Discover nearby AgSwarm nodes</p>
            </div>
            <button 
              onClick={onClose}
              className="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Radar Animation Area */}
          <div className="relative h-48 bg-gray-50 dark:bg-gray-950 flex items-center justify-center overflow-hidden border-b border-gray-100 dark:border-gray-800">
            {/* Concentric Circles */}
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="w-24 h-24 rounded-full border border-teal-500/20 dark:border-teal-400/10 absolute" />
              <div className="w-48 h-48 rounded-full border border-teal-500/20 dark:border-teal-400/10 absolute" />
              <div className="w-72 h-72 rounded-full border border-teal-500/20 dark:border-teal-400/10 absolute" />
            </div>

            {/* Scanning Sweep */}
            {isScanning && (
              <motion.div 
                animate={{ rotate: 360 }}
                transition={{ duration: 3, repeat: Infinity, ease: "linear" }}
                className="absolute w-72 h-72 rounded-full"
                style={{
                  background: 'conic-gradient(from 0deg, transparent 0deg, transparent 270deg, rgba(20, 184, 166, 0.1) 360deg)'
                }}
              />
            )}

            {/* Center Icon */}
            <div className="relative z-10 w-14 h-14 bg-white dark:bg-gray-800 rounded-full shadow-md border border-gray-100 dark:border-gray-700 flex items-center justify-center text-teal-600 dark:text-teal-400">
              <Radar className={`w-6 h-6 ${isScanning ? 'animate-pulse' : ''}`} />
            </div>

            {/* Connection Types */}
            <div className="absolute bottom-3 left-3 flex gap-2">
              <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400 bg-white/80 dark:bg-gray-800/80 backdrop-blur-sm px-2 py-1 rounded-full border border-gray-200 dark:border-gray-700">
                <Wifi className="w-3 h-3" /> LAN
              </div>
              <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400 bg-white/80 dark:bg-gray-800/80 backdrop-blur-sm px-2 py-1 rounded-full border border-gray-200 dark:border-gray-700">
                <Bluetooth className="w-3 h-3" /> BLE
              </div>
            </div>
          </div>

          {/* Device List */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-white dark:bg-gray-900">
            {discoveredDevices.length === 0 ? (
              <div className="h-32 flex flex-col items-center justify-center text-gray-500 dark:text-gray-400">
                {isScanning ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin mb-2 text-teal-500" />
                    <p className="text-sm">Looking for devices...</p>
                  </>
                ) : (
                  <p className="text-sm">No new devices found.</p>
                )}
              </div>
            ) : (
              <AnimatePresence>
                {discoveredDevices.map((device) => (
                  <motion.div
                    key={device.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="flex items-center justify-between p-4 rounded-2xl border border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50 hover:bg-white dark:hover:bg-gray-800 hover:shadow-sm transition-all group"
                  >
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 rounded-xl bg-white dark:bg-gray-700 shadow-sm border border-gray-100 dark:border-gray-600 flex items-center justify-center text-gray-600 dark:text-gray-300">
                        {device.type === 'laptop' && <Laptop className="w-5 h-5" />}
                        {device.type === 'desktop' && <Monitor className="w-5 h-5" />}
                        {device.type === 'mobile' && <Smartphone className="w-5 h-5" />}
                      </div>
                      <div>
                        <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100">{device.name}</h4>
                        <p className="text-xs text-gray-500 dark:text-gray-400 font-mono mt-0.5">{device.id}</p>
                      </div>
                    </div>
                    
                    <button
                      onClick={() => handleConnect(device)}
                      disabled={connectingTo !== null}
                      className={`px-4 py-2 rounded-xl text-sm font-medium transition-all ${
                        connectingTo === device.id
                          ? 'bg-teal-50 dark:bg-teal-900/30 text-teal-600 dark:text-teal-400'
                          : 'bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:border-teal-500 dark:hover:border-teal-500 hover:text-teal-600 dark:hover:text-teal-400 shadow-sm'
                      }`}
                    >
                      {connectingTo === device.id ? (
                        <span className="flex items-center gap-2">
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Connecting
                        </span>
                      ) : (
                        'Connect'
                      )}
                    </button>
                  </motion.div>
                ))}
              </AnimatePresence>
            )}
          </div>
          
          {/* Footer */}
          <div className="p-4 border-t border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 text-center">
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Make sure the AgSwarm client is open and discoverable on the target device.
            </p>
          </div>
        </motion.div>
      </div>
      )}
    </AnimatePresence>
  );
}
