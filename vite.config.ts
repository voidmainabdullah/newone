import { whop } from '@whop/cli/vite'
import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { cloudflare } from '@cloudflare/vite-plugin'

const config = defineConfig({
  // only these prefixes are ever exposed to the browser; secrets (GEMINI_API_KEY, DEEPSEEK_API_KEY) must never use them
  envPrefix: ['VITE_', 'NEXT_PUBLIC_'],
  resolve: { tsconfigPaths: true },
  plugins: [
    whop({ disableTanstackDevtools: true }),
    devtools(),
    cloudflare({ viteEnvironment: { name: 'ssr' } }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})

export default config
