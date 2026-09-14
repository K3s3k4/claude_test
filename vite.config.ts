import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // Tailscale等の他ネットワーク経由(スマホ含む)からもアクセスできるよう全インターフェースで待受
    watch: {
      // /mnt/c(WindowsドライブのOneDrive配下)ではinotifyが効かずホットリロードが動かないためポーリングに切り替え
      usePolling: true,
    },
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
})
