import React from 'react';

export function AppIcon({ className = "w-8 h-8" }: { className?: string }) {
  return (
    <svg 
      xmlns="http://www.w3.org/2000/svg" 
      viewBox="0 0 100 100" 
      className={className}
      fill="none"
    >
      {/* Background Squircle */}
      <rect 
        x="5" y="5" 
        width="90" height="90" 
        rx="24" 
        className="fill-teal-500 dark:fill-teal-600"
      />
      
      {/* Inner Glow / Gradient effect (simulated with opacity layers) */}
      <rect 
        x="5" y="5" 
        width="90" height="90" 
        rx="24" 
        fill="url(#icon-gradient)"
        className="opacity-50"
      />

      {/* Network Nodes */}
      {/* Central Node */}
      <circle cx="50" cy="45" r="12" fill="white" />
      
      {/* Orbiting Nodes */}
      <circle cx="30" cy="65" r="6" fill="white" className="opacity-90" />
      <circle cx="70" cy="65" r="6" fill="white" className="opacity-90" />
      <circle cx="50" cy="20" r="4" fill="white" className="opacity-70" />

      {/* Connecting Lines */}
      <path 
        d="M42 51 L33 60 M58 51 L67 60 M50 33 L50 24" 
        stroke="white" 
        strokeWidth="3" 
        strokeLinecap="round" 
        className="opacity-80"
      />

      {/* Sparkle / AI Star in the center */}
      <path 
        d="M50 40 C50 40 52 43 55 45 C52 47 50 50 50 50 C50 50 48 47 45 45 C48 43 50 40 50 40 Z" 
        fill="currentColor" 
        className="text-teal-500 dark:text-teal-600"
      />

      <defs>
        <linearGradient id="icon-gradient" x1="0" y1="0" x2="100" y2="100" gradientUnits="userSpaceOnUse">
          <stop stopColor="white" stopOpacity="0.4" />
          <stop offset="1" stopColor="black" stopOpacity="0.2" />
        </linearGradient>
      </defs>
    </svg>
  );
}
