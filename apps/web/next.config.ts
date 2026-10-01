import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@factory/db', '@factory/core', '@factory/agents', '@factory/connectors'],
  serverExternalPackages: ['@electric-sql/pglite'],
  experimental: {
    serverActions: { bodySizeLimit: '8mb' },
  },
  // security headers on every response — baseline hardening for a prod deploy
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=(self), geolocation=()' },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'", // Next dev + inline bootstrap need these
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob:",
              "font-src 'self' data:",
              "connect-src 'self' https://api.openrouter.ai https://api.sarvam.ai https://graph.facebook.com",
              "frame-ancestors 'none'",
            ].join('; '),
          },
        ],
      },
    ];
  },
  webpack: (config) => {
    // packages use NodeNext-style ".js" imports of ".ts" sources
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
};

export default nextConfig;
