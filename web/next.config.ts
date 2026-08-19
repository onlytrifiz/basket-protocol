import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  /**
   * `/distributions` shipped and was linked before the desk was renamed, so it is redirected rather
   * than dropped — a rename is only free until someone has shared the URL. Permanent, because it is.
   */
  async redirects() {
    return [
      // Both former names of this page. `/distributions` shipped and was linked; `/dividend` existed
      // for one commit on main, which is one commit longer than "never".
      { source: "/distributions", destination: "/dividends", permanent: true },
      { source: "/dividend", destination: "/dividends", permanent: true },
    ];
  },
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
