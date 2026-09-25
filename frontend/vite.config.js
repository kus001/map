// Vite.config.js

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from "@tailwindcss/vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],

  server: {
    port: 5173,
    allowedHosts: ["spaces.hackclub.com"], // from Kush: tried to get react website to open locally on HC spaces, but no luck :(
    proxy: {
      "/api": {
        target: "http://127.0.0.1:5000",
        changeOrigin: true
      }
    }
  }
});
