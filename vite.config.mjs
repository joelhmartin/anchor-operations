import { defineConfig, loadEnv } from 'vite';
import path from 'path';
import dotenv from 'dotenv';
import react from '@vitejs/plugin-react';
import jsconfigPaths from 'vite-jsconfig-paths';

dotenv.config({
  path: path.resolve(process.cwd(), '.env.public'),
  override: false
});

dotenv.config({
  path: path.resolve(process.cwd(), '.env'),
  override: false
});

export default defineConfig(({ mode }) => {
  // depending on your application, base can also be "/"
  const env = loadEnv(mode, process.cwd(), '');
  const API_URL = `${env.VITE_APP_BASE_NAME}`;
  const PORT = 3000;
  const API_PORT = env.API_SERVER_PORT || 4000;

  return {
    server: {
      // this ensures that the browser opens upon server start
      open: true,
      // this sets a default port to 3000
      port: PORT,
      host: true,
      proxy: {
        '/api': {
          target: `http://localhost:${API_PORT}`,
          changeOrigin: true
        },
        // Public embed endpoints are served by the API server in dev.
        // Proxy them so `http://localhost:3000/embed/...` works for local embed testing.
        '/embed': {
          target: `http://localhost:${API_PORT}`,
          changeOrigin: true
        },
        // Uploaded assets are served by the API server.
        '/uploads': {
          target: `http://localhost:${API_PORT}`,
          changeOrigin: true
        }
      }
    },
    build: {
      chunkSizeWarningLimit: 1600,
      rollupOptions: {
        output: {
          entryFileNames: 'assets/[name]-[hash].js',
        },
      },
    },
    esbuild: {
      drop: mode === 'production' ? ['console', 'debugger'] : []
    },
    preview: {
      open: true,
      host: true
    },
    define: {
      global: 'window'
    },
    resolve: {
      alias: {
        // { find: '', replacement: path.resolve(__dirname, 'src') },
        // {
        //   find: /^~(.+)/,
        //   replacement: path.join(process.cwd(), 'node_modules/$1')
        // },
        // {
        //   find: /^src(.+)/,
        //   replacement: path.join(process.cwd(), 'src/$1')
        // }
        // {
        //   find: 'assets',
        //   replacement: path.join(process.cwd(), 'src/assets')
        // },
        '@tabler/icons-react': '@tabler/icons-react/dist/esm/icons/index.mjs',
        '@mui/material/Grid': '@mui/material/GridLegacy',
        '@mui/material/Grid/index.js': '@mui/material/GridLegacy/index.js'
      }
    },
    base: API_URL,
    plugins: [react(), jsconfigPaths()]
  };
});
