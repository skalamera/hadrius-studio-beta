import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const OUT_DIR = path.resolve('out/Archiving-LLMs-Claude');
const SLIDES_DIR = path.join(OUT_DIR, 'slides');
const CHROME_PROFILE_DIR = '/tmp/chrome_test_root_frames';

fs.mkdirSync(SLIDES_DIR, { recursive: true });

async function injectCleanStyles(page) {
  await page.evaluate(() => {
    // 1. Remove agentation-toolbar
    document.querySelectorAll('agentation-toolbar').forEach(el => el.remove());

    // 2. Inject global cleanup style
    let style = document.getElementById('studio-clean-styles');
    if (!style) {
      style = document.createElement('style');
      style.id = 'studio-clean-styles';
      document.head.appendChild(style);
    }
    style.innerHTML = `
      agentation-toolbar, [class*="toolbar___"], [class*="toolbarContainer___"] { display: none !important; }
    `;

    // 3. Hide staging pill
    document.querySelectorAll('div.fixed').forEach(el => {
      if (el.innerText && el.innerText.trim() === 'STAGING') {
        el.style.display = 'none';
      }
    });
  });
}

async function run() {
  console.log('Launching browser to capture polished LLM Archiving walkthrough...');
  const ctx = await chromium.launchPersistentContext(CHROME_PROFILE_DIR, {
    headless: true,
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor: 1
  });

  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);

  // Initial navigation to Integrations
  console.log('Navigating to Settings -> Integrations...');
  await page.goto('https://staging.hadrius.com/settings/integrations', { waitUntil: 'networkidle' });

  // Clean impersonation if any
  await page.evaluate(() => {
    localStorage.removeItem('impersonated-user-id');
    localStorage.removeItem('impersonated-user-uuid');
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await injectCleanStyles(page);

  const targets = {};

  // --- SLIDE 1: Open company switcher showing Ritholtz Wealth Management (725) ---
  console.log('Capturing Slide 1: Company selector with Ritholtz Wealth Management...');
  const compBtn = page.locator('button:has-text("Ritholtz"), button:has-text("725"), button:has-text("Hadrius Sandbox")').first();
  await compBtn.click();
  await page.waitForTimeout(600);
  const searchInput = page.locator('input[placeholder*="Search"]').last();
  await searchInput.fill('rith');
  await page.waitForTimeout(800);
  await injectCleanStyles(page);

  targets.slide1 = { x: 35, y: 185, width: 250, height: 44 };
  await page.screenshot({ path: path.join(SLIDES_DIR, 'slide_01.png') });

  // Close dropdown
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // --- SLIDE 2: Settings -> Integrations with Claude Connected highlighted in center ---
  console.log('Capturing Slide 2: Integrations page with Claude card centered...');
  // Scroll main container so AI assistants is centered
  await page.evaluate(() => {
    const scrollers = document.querySelectorAll('div.overflow-y-auto');
    if (scrollers[1]) scrollers[1].scrollTop = 180;
  });
  await page.waitForTimeout(600);
  await injectCleanStyles(page);

  const claudeCard = page.locator('div:has-text("Claude"):has-text("Connected")').last();
  const claudeBox = await claudeCard.boundingBox();
  console.log('Scrolled Claude card box:', claudeBox);
  targets.slide2 = claudeBox ? {
    x: Math.round(claudeBox.x - 8),
    y: Math.round(claudeBox.y - 8),
    width: Math.round(claudeBox.width + 16),
    height: Math.round(claudeBox.height + 16)
  } : { x: 300, y: 380, width: 420, height: 120 };
  await page.screenshot({ path: path.join(SLIDES_DIR, 'slide_02.png') });

  // --- SLIDE 3: Navigate to Claude Manage page ---
  console.log('Navigating to Claude Manage page...');
  const manageBtn = page.getByRole('button', { name: 'Manage' }).first();
  await manageBtn.click();
  await page.waitForTimeout(1500);
  await injectCleanStyles(page);

  targets.slide3 = { x: 300, y: 440, width: 880, height: 380 };
  await page.screenshot({ path: path.join(SLIDES_DIR, 'slide_03.png') });

  // --- SLIDE 4: Highlight "At a glance" panel on the Claude page ---
  console.log('Capturing Slide 4: At a glance panel...');
  targets.slide4 = { x: 1230, y: 360, width: 330, height: 360 };
  await page.screenshot({ path: path.join(SLIDES_DIR, 'slide_04.png') });

  // --- SLIDE 5: Navigate to Anthropic Activity Event Log ---
  console.log('Navigating to Anthropic Activity Log...');
  await page.goto('https://staging.hadrius.com/account/settings/anthropic-activity', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await injectCleanStyles(page);

  targets.slide5 = { x: 285, y: 280, width: 1275, height: 380 };
  await page.screenshot({ path: path.join(SLIDES_DIR, 'slide_05.png') });

  // --- SLIDE 6: Open Event Detail Drawer ---
  console.log('Opening Event Detail Drawer...');
  const firstRow = page.locator('table tbody tr').first();
  await firstRow.click();
  await page.waitForTimeout(1200);
  await injectCleanStyles(page);

  targets.slide6 = { x: 1160, y: 220, width: 400, height: 480 };
  await page.screenshot({ path: path.join(SLIDES_DIR, 'slide_06.png') });

  // --- SLIDE 7: Return to Integrations summary ---
  console.log('Returning to Integrations summary...');
  await page.goto('https://staging.hadrius.com/settings/integrations', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const scrollers = document.querySelectorAll('div.overflow-y-auto');
    if (scrollers[1]) scrollers[1].scrollTop = 180;
  });
  await page.waitForTimeout(600);
  await injectCleanStyles(page);

  targets.slide7 = { x: 300, y: 330, width: 920, height: 260 };
  await page.screenshot({ path: path.join(SLIDES_DIR, 'slide_07.png') });

  await ctx.close();
  console.log('Polished slides captured successfully! Targets:', targets);
  fs.writeFileSync(path.join(OUT_DIR, 'targets.json'), JSON.stringify(targets, null, 2));
}

run().catch(console.error);
