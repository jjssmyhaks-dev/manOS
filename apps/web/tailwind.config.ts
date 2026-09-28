import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: ['class'],
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        border: 'var(--border)',
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        muted: { DEFAULT: 'var(--muted)', foreground: 'var(--muted-foreground)' },
        primary: { DEFAULT: 'var(--primary)', foreground: 'var(--primary-foreground)' },
        destructive: { DEFAULT: 'var(--destructive)', foreground: 'var(--destructive-foreground)' },
        card: { DEFAULT: 'var(--card)', foreground: 'var(--card-foreground)' },
        'brand-deep': 'var(--brand-deep)',
        'brand-soft': 'var(--brand-soft)',
        banner: 'var(--banner)',
        cta: { DEFAULT: 'var(--cta)', foreground: 'var(--cta-foreground)', hover: 'var(--cta-hover)' },
      },
      borderRadius: { lg: '0.5rem', md: '0.375rem', sm: '0.25rem' },
    },
  },
  plugins: [],
};
export default config;
