import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@factory/db', '@factory/core', '@factory/agents', '@factory/connectors'],
  serverExternalPackages: ['@electric-sql/pglite'],
  experimental: {
    serverActions: { bodySizeLimit: '8mb' },
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
