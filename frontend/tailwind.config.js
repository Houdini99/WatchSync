/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // Theme tokens resolve to CSS variables defined in src/index.css, so the
      // light/dark switch is a single attribute flip on <html>.
      colors: {
        bg: 'var(--bg)',
        surface: 'var(--bg-elev)',
        surface2: 'var(--bg-elev-2)',
        border: 'var(--border)',
        text: 'var(--text)',
        dim: 'var(--text-dim)',
        accent: 'var(--accent)',
        'accent-hover': 'var(--accent-hover)',
        danger: 'var(--danger)',
        success: 'var(--success)',
        warn: 'var(--warn)',
      },
      boxShadow: {
        panel: 'var(--shadow)',
      },
      borderRadius: {
        card: '16px',
      },
    },
  },
  plugins: [],
};
