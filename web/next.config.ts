import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  /**
   * `/distributions` shipped and was linked before the desk was renamed, so it is redirected rather
   * than dropped — a rename is only free until someone has shared the URL. Permanent, because it is.
   */
  async redirects() {
    return [{ source: "/distributions", destination: "/dividend", permanent: true }];
  },
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
