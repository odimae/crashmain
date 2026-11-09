import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In development, /api calls are forwarded to the backend, so there are no CORS problems.
// Change the port below if your backend PORT in .env is not 4100.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:4100' } },
})
