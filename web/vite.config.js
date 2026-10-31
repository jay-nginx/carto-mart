import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Carto SPA Vite config. The runtime (nginx) serves dist/. Sourcemaps
// on so the RUM source-map upload can symbolicate browser error stacks.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': { target: 'http://bff:8080', changeOrigin: true },
    },
  },
  build: {
    sourcemap: true,
    outDir: 'dist',
  },
});
