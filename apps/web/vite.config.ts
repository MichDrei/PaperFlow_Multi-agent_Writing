import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

const pkg = (name: string) =>
  fileURLToPath(new URL(`../../packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@paperflow/core': pkg('core'),
      '@paperflow/context': pkg('context'),
      '@paperflow/latex': pkg('latex'),
      '@paperflow/ui': pkg('ui'),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5273,
    strictPort: true,
    host: '127.0.0.1',
    proxy: {
      // 把 /api 转发到编排服务：好处是**同源**，既彻底绕开 CORS，
      // 也让前端不必配置 VITE_API_BASE —— `npm run dev` 起来就自动接上后端。
      // 后端没启动时请求会 502，前端探测失败后自动退回浏览器内 mock。
      // 群聊房间的 WebSocket 也必须转发（漏了它：浏览器连上的是 Vite 自己，
      // 后端一条广播都收不到 —— 实测就是"别人看不到任何消息"）
      '/room': {
        target: process.env.VITE_API_PROXY_TARGET ?? 'http://127.0.0.1:8787',
        ws: true,
        changeOrigin: false,
      },
      // 实时协同的 WebSocket 也要转发到后端（ws: true 才会走 upgrade）
      '/collab': {
        target: process.env.VITE_API_PROXY_TARGET ?? 'http://127.0.0.1:8787',
        ws: true,
        changeOrigin: false,
      },
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET ?? 'http://127.0.0.1:8787',
        changeOrigin: false,
      },
    },
    fs: {
      // 允许读取 monorepo 内 packages/* 的源码
      allow: [fileURLToPath(new URL('../..', import.meta.url))],
    },
  },
  optimizeDeps: {
    include: ['monaco-editor', 'pdfjs-dist'],
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 4096,
  },
});
