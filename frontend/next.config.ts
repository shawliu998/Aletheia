import type { NextConfig } from "next";

const nextConfig: NextConfig = {
    /* config options here */
    reactCompiler: true,
    // The development badge overlaps primary controls in Word's narrow taskpane.
    // Runtime errors still surface through the normal development overlay/console.
    devIndicators: false,
    async rewrites() {
        return [
            {
                source: "/sitemap.xml",
                destination: "/api/sitemap/sitemap.xml",
            },
            {
                source: "/sitemap_:slug.xml",
                destination: "/api/sitemap/sitemap_:slug.xml",
            },
        ];
    },
    skipTrailingSlashRedirect: true,
};

export default nextConfig;
