import type { NextConfig } from 'next';

const target = process.env.CONTROLLER_API_URL || 'http://127.0.0.1:8787';
const url = new URL(target);
const localhost = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash
  || (url.protocol === 'http:' && !localhost)) {
  throw new Error('CONTROLLER_API_URL must be a credential-free localhost origin or an https origin.');
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${target}/api/:path*` }];
  },
};

export default nextConfig;
