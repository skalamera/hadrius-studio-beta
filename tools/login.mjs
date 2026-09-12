// Hadrius Studio -- one-time login for the renderer's own browser profile.
//
// Run this once, and again whenever the saved session expires. It opens a real, visible
// browser window pointed at staging.hadrius.com. Log in there (2FA if prompted), then come
// back to this terminal and press Ctrl+C once you see the app -- the profile saves
// continuously to disk as you use it (it's a real Chrome user-data-dir), so there's nothing
// extra to "commit" on exit.
//
// Every future render.sh run launches its own headless browser from this saved profile --
// no manual browser window to keep open.
//
// Usage: node tools/login.mjs

import { chromium } from 'playwright';
import path from 'node:path';

const PROFILE_DIR = path.join(process.cwd(), '.browser-profile');
const START_URL = process.env.KBS_START_URL || 'https://staging.hadrius.com/overview';

console.log('Opening a browser window. Log in to Hadrius (including 2FA if asked).');
console.log('Profile will be saved to:', PROFILE_DIR);
console.log('Once you are logged in and see the app, press Ctrl+C here to finish.\n');

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  viewport: { width: 1600, height: 900 },
});
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto(START_URL);

process.on('SIGINT', async () => {
  console.log('\nSaved.');
  await ctx.close();
  process.exit(0);
});

// Keep the process alive until Ctrl+C.
await new Promise(() => {});
