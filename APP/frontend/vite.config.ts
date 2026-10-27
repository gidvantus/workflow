import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// Сборка кладёт статику в dist, её отдаёт nginx из образа web.
//
// Dev-режим тоже ходит на относительный /api: адрес стенда не зашит в код, его берёт
// прокси. Цель прокси задаётся окружением (VITE_API_PROXY_TARGET), по умолчанию —
// порт api из `.env.example`; в контейнере проксирует nginx, эта настройка не используется.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', 'VITE_');

  return {
    plugins: [react()],
    server: {
      host: '0.0.0.0',
      port: 5173,
      proxy: {
        '/api': {
          target: env.VITE_API_PROXY_TARGET ?? 'http://localhost:8096',
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
    },
  };
});
