import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  root: "web",
  publicDir: "public",
  build: { outDir: "../dist", emptyOutDir: true },
  plugins: [
    react(),
    tailwindcss(),
    cloudflare({ configPath: "../wrangler.jsonc", persistState: { path: "../.wrangler/state" } }),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: false,
      strategies: "generateSW",
      manifest: {
        name: "Intent-Trace",
        short_name: "IntentTrace",
        description: "空間・設備・安全の統合マネジメント",
        lang: "ja",
        start_url: "/",
        display: "standalone",
        background_color: "#0f172a",
        theme_color: "#0f172a",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
        ]
      },
      workbox: {
        // 新しいバージョンを待機させずに即座に有効化（古い画面のまま残らないように）
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//, /^\/ws\//],
        globPatterns: ["**/*.{js,css,html,png,svg,webmanifest}"],
        runtimeCaching: [
          {
            // 設備カルテ・マスタは地下室等でも参照できるよう NetworkFirst でキャッシュ
            urlPattern: ({ url }) =>
              url.pathname.startsWith("/api/tags/") || url.pathname.startsWith("/api/equipment/") || url.pathname === "/api/me",
            handler: "NetworkFirst",
            method: "GET",
            options: { cacheName: "api-read", networkTimeoutSeconds: 4, expiration: { maxEntries: 500, maxAgeSeconds: 7 * 86400 } }
          },
          {
            urlPattern: ({ url }) => url.pathname.startsWith("/api/files/"),
            handler: "CacheFirst",
            method: "GET",
            options: { cacheName: "files", expiration: { maxEntries: 100, maxAgeSeconds: 30 * 86400 } }
          }
        ]
      }
    })
  ]
});
