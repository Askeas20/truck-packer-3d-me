import { readFile } from 'node:fs/promises';
import { defineConfig } from 'vite';

const VENDOR_FALLBACK_FILES = [
  'fa-brands-400.woff2',
  'fa-solid-900.woff2',
  'fontawesome.min.css',
  'jspdf.umd.min.js',
  'supabase.min.js',
  'tween.umd.js',
  'xlsx.full.min.js',
];

function preserveVendorFallbacks() {
  return {
    name: 'tp3d-preserve-vendor-fallbacks',
    apply: 'build',
    async generateBundle() {
      await Promise.all(
        VENDOR_FALLBACK_FILES.map(async fileName => {
          this.emitFile({
            type: 'asset',
            fileName: `vendor/${fileName}`,
            source: await readFile(new URL(`./vendor/${fileName}`, import.meta.url)),
          });
        })
      );
    },
  };
}

// Plugin koji automatski ubacuje "bypass" skriptu u buildovani HTML
function injectBillingBypass() {
  return {
    name: 'tp3d-billing-bypass',
    transformIndexHtml(html) {
      return html.replace(
        '<head>',
        `<head>
        <script>
          // Automatski presreće biling poziv i podmeće lažni Pro status
          const originalFetch = window.fetch;
          window.fetch = async (...args) => {
            if (typeof args[0] === 'string' && args[0].includes('billing-status')) {
              return new Response(JSON.stringify({
                ok: true,
                isPro: true,
                isActive: true,
                plan: 'pro',
                entitlementStatus: 'active',
                data: { subscription: { status: 'active' }, isActive: true }
              }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
              });
            }
            return originalFetch(...args);
          };
        </script>`
      );
    },
  };
}

export default defineConfig({
  base: './',
  server: {
    host: 'localhost',
    port: 5500,
    strictPort: true,
  },
  preview: {
    host: 'localhost',
    port: 5500,
    strictPort: true,
  },
  build: {
    target: ['chrome90', 'edge90', 'firefox103', 'safari13.1'],
    outDir: 'dist',
    emptyOutDir: true,
  },
  plugins: [preserveVendorFallbacks(), injectBillingBypass()],
});