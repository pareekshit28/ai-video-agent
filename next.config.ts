import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: [
      // Native POST forms need a same-origin Origin header for CSRF validation.
      // no-referrer makes browsers send Origin: null on navigation submissions.
      { key: "Referrer-Policy", value: "same-origin" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Content-Security-Policy", value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'" },
    ] }, {
      source: "/auth/callback",
      headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
    }];
  },
};
export default config;
