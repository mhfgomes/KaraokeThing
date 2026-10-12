import type { NextConfig } from "next";
import { networkInterfaces } from 'node:os';

const nextConfig: NextConfig = {
  output: process.env.KARAOKE_STANDALONE === '1' ? 'standalone' : undefined,
  serverExternalPackages: ['music-metadata', 'busboy'],
  allowedDevOrigins: Object.values(networkInterfaces()).flatMap(entries => (entries || []).filter(address => address.family === 'IPv4').map(address => address.address)),
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
