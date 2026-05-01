import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// See https://wxt.dev/api/config.html
export default defineConfig({
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  manifestVersion: 3,
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Ex Grok',
    description:
      'Queue and automate Grok video workflows with a side panel control surface.',
    permissions: ['alarms', 'downloads', 'storage', 'tabs'],
    host_permissions: ['https://grok.com/*', 'https://*.grok.com/*'],
  },
  // To use your existing Chrome profile with `npm run dev`, uncomment the
  // runner block below and set the profile path.  You must quit Chrome first
  // (File → Quit) before running, because Chrome won't share a profile with
  // a second instance.
  //
  // runner: {
  //   chromiumArgs: [
  //     '--user-data-dir=/Users/hamburger/Library/Application Support/Google/Chrome',
  //   ],
  // },
});
