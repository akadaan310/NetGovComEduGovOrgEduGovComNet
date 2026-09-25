import type { NextConfig } from 'next';

const config: NextConfig = {
  // The protocol surface is served by a single route handler; see src/transport/handler.ts.
  poweredByHeader: false,
  // `pg` uses optional native bindings; PGlite ships WASM. Keep both out of the bundle.
  serverExternalPackages: ['pg', '@electric-sql/pglite'],
  skipTrailingSlashRedirect: true,
};

export default config;
