/** geniusDebug design tokens — brief §2. Never hardcode hex in components. */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        surface: 'var(--surface)',
        'surface-2': 'var(--surface-2)',
        border: 'var(--border)',
        text: 'var(--text)',
        'text-muted': 'var(--text-muted)',
        'text-faint': 'var(--text-faint)',
        accent: 'var(--accent)',
        'accent-strong': 'var(--accent-strong)',
        'level-fatal': '#7B2CBF',
        'level-error': '#E5484D',
        'level-warning': '#F5A623',
        'level-info': '#4C82F7',
        'level-debug': '#8A8A98',
        'status-unresolved': '#E5484D',
        'status-resolved': '#30A46C',
        'status-muted': '#8A8A98',
        regressed: '#F5A623',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      borderRadius: { sm: '4px', md: '6px', lg: '10px' },
      fontSize: {
        display: ['24px', '32px'],
        h1: ['20px', '28px'],
        h2: ['16px', '24px'],
        body: ['14px', '20px'],
        small: ['13px', '18px'],
        caption: ['12px', '16px'],
        mono: ['13px', '20px'],
      },
    },
  },
  plugins: [],
};
