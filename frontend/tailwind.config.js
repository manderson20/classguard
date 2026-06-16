/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // Primary blue — matches the ClassGuard logo shield/wordmark blue
        primary: {
          50:  '#eff6ff',
          100: '#dbeafe',
          200: '#bfdbfe',
          300: '#93c5fd',
          400: '#60a5fa',
          500: '#3b82f6',
          600: '#2563eb',   // logo blue
          700: '#1d4ed8',
          800: '#1e40af',
          900: '#1e3a8a',
          950: '#172554',
        },
        // Sidebar surface — dark navy, distinct from generic slate
        sidebar: {
          bg:          '#0f172a',   // main sidebar background
          hover:       '#1e293b',   // hover state
          active:      '#2563eb',   // active/selected (logo blue)
          border:      '#1e293b',   // section dividers
          text:        '#94a3b8',   // default nav text
          'text-hover':'#f1f5f9',   // hover nav text
          heading:     '#475569',   // section label
        },
      },
    },
  },
  plugins: [],
};
