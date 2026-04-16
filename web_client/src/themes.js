export const THEME_BASES = [
  { id: 'stitch', name: 'Stitch Light (Default)', type: 'light', colors: ['#ffffff', '#5e19e6', '#8f5cf0', '#9c99ad'] },
  { id: 'void_purple', name: 'Void Purple', type: 'dark', colors: ['#0D0D0D', '#7B2FFF', '#BF5FFF', '#F0C4FF'] },
  { id: 'arctic_core', name: 'Arctic Core', type: 'dark', colors: ['#04060F', '#0070FF', '#00C8FF', '#AAEEFF'] },
  { id: 'midnight_rose', name: 'Midnight Rose', type: 'dark', colors: ['#0A0A0A', '#FF2D55', '#FF6B9E', '#FFF0F5'] },
  { id: 'matrix_mint', name: 'Matrix Mint', type: 'dark', colors: ['#080808', '#00FF88', '#00CC6A', '#90FFD0'] },
  { id: 'ember_dark', name: 'Ember Dark', type: 'dark', colors: ['#13111C', '#FF8C42', '#FFB347', '#FFD9A0'] },
  { id: 'lavender_web', name: 'Lavender Web', type: 'light', colors: ['#F5F0FF', '#D4B0FF', '#9B6BFF', '#2A0080'] },
  { id: 'neon_slime', name: 'Neon Slime', type: 'dark', colors: ['#0C0F0A', '#39FF14', '#8FFF60', '#F2FFEA'] },
  { id: 'terracotta', name: 'Terracotta Cloud', type: 'light', colors: ['#FFF8F0', '#FFCBA4', '#FF8C61', '#3D1100'] },
  { id: 'deep_sea', name: 'Deep Sea UI', type: 'dark', colors: ['#08090D', '#1E2A4A', '#4A7FFF', '#E8F0FF'] },
  { id: 'matcha', name: 'Matcha Light', type: 'light', colors: ['#F0FFF8', '#3CDBA8', '#00896B', '#00362A'] },
  { id: 'vaporwave', name: 'Vaporwave DM', type: 'dark', colors: ['#0E0416', '#8B00FF', '#FF00C8', '#FF80E8'] },
  { id: 'gold', name: 'Gold Status', type: 'light', colors: ['#FFFBF0', '#FFE680', '#FFC200', '#3A2800'] },
  { id: 'stealth', name: 'Stealth Mode', type: 'dark', colors: ['#0D0D12', '#1A1A28', '#E0E0F5', '#FFFFFF'] },
  { id: 'barbie', name: 'Y2K Barbie', type: 'light', colors: ['#FFF0FA', '#FF55B8', '#CC0080', '#500030'] },
  { id: 'cobalt', name: 'Cobalt Protocol', type: 'dark', colors: ['#090B14', '#00B4D8', '#90E0EF', '#CAF0F8'] }
];

export const THEME_GRADIENTS = [
  { id: 'none', name: 'Flat Color (Clean)', value: 'none' },
  { id: 'stitch', name: 'Stitch App', value: 'linear-gradient(135deg, #3922de 0%, #54a6ff 100%)' },
  { id: 'galactic', name: 'Galactic Night', value: 'linear-gradient(135deg, #0f0c29, #302b63, #24243e)' },
  { id: 'rave', name: 'Rave Core', value: 'linear-gradient(135deg, #ff0080, #7928ca, #4b0082)' },
  { id: 'aurora', name: 'Aurora Swim', value: 'linear-gradient(135deg, #00f5a0, #00d9f5, #007aff)' },
  { id: 'lava', name: 'Lava Drip', value: 'linear-gradient(135deg, #ff6b35, #f72585, #7209b7)' },
  { id: 'abyss', name: 'Abyss Blue', value: 'linear-gradient(135deg, #0a0a0a, #1a1a2e, #0f3460)' },
  { id: 'amber', name: 'Amber Blaze', value: 'linear-gradient(135deg, #fddb92, #f97316, #c2410c)' },
  { id: 'pastel', name: 'Pastel Drift', value: 'linear-gradient(135deg, #e0c3fc, #8ec5fc, #b8f4e8)' },
  { id: 'phantom', name: 'Phantom Haze', value: 'linear-gradient(135deg, #1f1c2c, #928dab)' },
  { id: 'cyber', name: 'Cyber Mint', value: 'linear-gradient(135deg, #00c9ff, #92fe9d)' },
  { id: 'solar', name: 'Solar Punch', value: 'linear-gradient(135deg, #fc4a1a, #f7b733)' },
  { id: 'ocean', name: 'Deep Ocean', value: 'linear-gradient(135deg, #0f2027, #203a43, #2c5364)' },
  { id: 'sakura', name: 'Sakura Haze', value: 'linear-gradient(135deg, #ff9a9e, #fecfef, #feada6)' },
  { id: 'prism', name: 'Prism Burst', value: 'linear-gradient(135deg, #12c2e9, #c471ed, #f64f59)' },
  { id: 'steel', name: 'Midnight Steel', value: 'linear-gradient(135deg, #141e30, #243b55)' },
  { id: 'sunset', name: 'Sunset Drip', value: 'linear-gradient(135deg, #a18cd1, #fbc2eb, #ffd6a5, #fdffb6)' }
];

export function applyTheme(baseId, gradientId) {
  const base = THEME_BASES.find(t => t.id === baseId) || THEME_BASES[0];
  const grad = THEME_GRADIENTS.find(g => g.id === gradientId) || THEME_GRADIENTS[0];
  
  const root = document.documentElement;
  
  // Set gradients
  const flatBg = base.type === 'dark' ? '#0A0A0E' : '#E8EAED';
  root.style.setProperty('--bg-app-gradient', grad.value === 'none' ? flatBg : grad.value);
  
  // Also use the gradient for out-bound messages so it feels consistent
  root.style.setProperty('--msg-out-bg', grad.value === 'none' ? base.colors[1] : grad.value);
  
  // Set base coloring
  root.style.setProperty('--bg-workspace', base.colors[0]);
  root.style.setProperty('--bg-surface', base.colors[0]);
  root.style.setProperty('--brand', base.colors[1]);
  root.style.setProperty('--brand-light', base.colors[2]);
  
  if (base.type === 'dark') {
    // Override light values for dark mode
    root.style.setProperty('--text-primary', '#ffffff');
    root.style.setProperty('--text-secondary', 'rgba(255, 255, 255, 0.7)');
    root.style.setProperty('--text-muted', 'rgba(255, 255, 255, 0.45)');
    root.style.setProperty('--border', 'rgba(255, 255, 255, 0.12)');
    root.style.setProperty('--border-focus', 'rgba(255, 255, 255, 0.3)');
    root.style.setProperty('--bg-hover', 'rgba(255, 255, 255, 0.08)');
    root.style.setProperty('--bg-active', 'rgba(255, 255, 255, 0.05)');
    root.style.setProperty('--bg-glass', 'rgba(0, 0, 0, 0.6)');
    
    // Messages
    root.style.setProperty('--msg-in-bg', 'rgba(255, 255, 255, 0.1)');
    root.style.setProperty('--msg-in-color', '#ffffff');
    root.style.setProperty('--msg-out-color', '#ffffff'); // Sent message usually white text on dark grad
    
    // Auth inputs bg for dark
    document.documentElement.style.setProperty('--bg-input', 'rgba(255,255,255,0.05)');

  } else {
    // Reset to light values 
    root.style.setProperty('--text-primary', '#15132b');
    root.style.setProperty('--text-secondary', '#6d6985');
    root.style.setProperty('--text-muted', '#9c99ad');
    root.style.setProperty('--border', 'rgba(0,0,0,0.06)');
    root.style.setProperty('--border-focus', 'rgba(94, 25, 230, 0.4)');
    root.style.setProperty('--bg-hover', 'rgba(94, 25, 230, 0.06)');
    root.style.setProperty('--bg-active', '#ffffff');
    root.style.setProperty('--bg-glass', 'rgba(255, 255, 255, 0.85)');
    
    // Messages
    root.style.setProperty('--msg-in-bg', '#f2f4ff');
    root.style.setProperty('--msg-in-color', 'var(--text-primary)');
    root.style.setProperty('--msg-out-color', '#ffffff');
    
    document.documentElement.style.setProperty('--bg-input', '#f8f9fc');
  }
}
