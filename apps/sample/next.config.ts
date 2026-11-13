import type { NextConfig } from "next";

const siteSlug = process.env.SITE_SLUG;
const standaloneSite = siteSlug === "ledger" || siteSlug === "switchboard" || siteSlug === "hopper" || siteSlug === "relay";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async rewrites() {
    if (!standaloneSite || !siteSlug) return [];
    return [{ source: "/", destination: `/sites/${siteSlug}` }];
  }
};

export default nextConfig;
