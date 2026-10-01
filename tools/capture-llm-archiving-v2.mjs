import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const OUT_DIR = path.resolve('out/Archiving-LLMs-Claude');
const SLIDES_DIR = path.join(OUT_DIR, 'slides');
const CHROME_PROFILE_DIR = '/tmp/chrome_test_root_frames';

fs.mkdirSync(SLIDES_DIR, { recursive: true });

async function sanitizeAndClean(page) {
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

    // 4. Sanitize firm name across all text nodes (replace Ritholtz with Hadrius Demo)
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue && node.nodeValue.toLowerCase().includes('ritholtz')) {
        node.nodeValue = node.nodeValue.replace(/Ritholtz Wealth Management/gi, 'Hadrius Demo').replace(/Ritholtz/gi, 'Hadrius Demo');
      }
      if (node.nodeValue && node.nodeValue.trim() === '725') {
        node.nodeValue = '';
      }
    }
  });
}

async function run() {
  console.log('Launching browser for LLM Archiving v2 (generic firm, zero Ritholtz)...');
  const ctx = await chromium.launchPersistentContext(CHROME_PROFILE_DIR, {
    headless: true,
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor: 1
  });

  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);

  // Navigate to Integrations
  console.log('Navigating to Settings -> Integrations...');
  await page.goto('https://staging.hadrius.com/settings/integrations', { waitUntil: 'networkidle' });

  // Clear any impersonation
  await page.evaluate(() => {
    localStorage.removeItem('impersonated-user-id');
    localStorage.removeItem('impersonated-user-uuid');
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // Scroll main container slightly so AI assistants section is nicely centered
  const scrollOffset = 80;
  await page.evaluate((top) => {
    const scrollers = document.querySelectorAll('div.overflow-y-auto');
    if (scrollers[1]) scrollers[1].scrollTop = top;
  }, scrollOffset);
  await page.waitForTimeout(600);
  await sanitizeAndClean(page);

  // Measure Slide 1 target: Entire AI assistants section
  console.log('Capturing Slide 1: AI assistants section...');
  const targets = {};
  targets.slide1 = { x: 300, y: 520 - scrollOffset, width: 830, height: 220 };
  await page.screenshot({ path: path.join(SLIDES_DIR, 'slide_01.png') });

  // Measure Slide 2 target: Exact Claude card container
  console.log('Capturing Slide 2: Claude Connected card...');
  const claudeBox = await page.evaluate(() => {
    const manageBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.trim() === 'Manage');
    let card = manageBtn;
    while (card && !card.className.includes('rounded-[var(--h-radius-default)]')) {
      card = card.parentElement;
    }
    const r = card ? card.getBoundingClientRect() : null;
    return r ? { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } : null;
  });
  console.log('Slide 2 Claude box:', claudeBox);
  targets.slide2 = claudeBox || { x: 310, y: 566 - scrollOffset, width: 401, height: 165 };
  await page.screenshot({ path: path.join(SLIDES_DIR, 'slide_02.png') });

  // Navigate to Claude Manage page
  console.log('Navigating to Claude Manage page...');
  const manageBtn = page.getByRole('button', { name: 'Manage' }).first();
  await manageBtn.click();
  await page.waitForTimeout(1500);
  await sanitizeAndClean(page);

  // Slide 3: Connection details card
  console.log('Capturing Slide 3: Connection details card...');
  const connBox = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('*')).filter(el => {
      const cls = el.className || '';
      return typeof cls === 'string' && cls.includes('border') && cls.includes('rounded') && el.innerText && el.innerText.includes('Connection details');
    });
    // Pick the outer card container
    const c = cards.find(el => el.getBoundingClientRect().width > 700);
    const r = c ? c.getBoundingClientRect() : null;
    return r ? { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } : null;
  });
  console.log('Slide 3 Connection box:', connBox);
  targets.slide3 = connBox || { x: 310, y: 403, width: 900, height: 431 };
  await page.screenshot({ path: path.join(SLIDES_DIR, 'slide_03.png') });

  // Slide 4: At a glance card
  console.log('Capturing Slide 4: At a glance panel...');
  const glanceBox = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('*')).filter(el => {
      const cls = el.className || '';
      return typeof cls === 'string' && cls.includes('border') && cls.includes('rounded') && el.innerText && el.innerText.includes('At a glance');
    });
    const c = cards.find(el => el.getBoundingClientRect().width > 250 && el.getBoundingClientRect().width < 400);
    const r = c ? c.getBoundingClientRect() : null;
    return r ? { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } : null;
  });
  console.log('Slide 4 At a glance box:', glanceBox);
  targets.slide4 = glanceBox || { x: 1226, y: 319, width: 320, height: 476 };
  await page.screenshot({ path: path.join(SLIDES_DIR, 'slide_04.png') });

  // Slide 5: Event Watch Anthropic Activity
  console.log('Navigating to Anthropic Activity...');
  await page.goto('https://staging.hadrius.com/account/settings/anthropic-activity', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  await sanitizeAndClean(page);

  console.log('Capturing Slide 5: Event log table...');
  targets.slide5 = { x: 290, y: 259, width: 1276, height: 430 };
  await page.screenshot({ path: path.join(SLIDES_DIR, 'slide_05.png') });

  // Slide 6: Click first row to open drawer
  console.log('Opening Event Detail Drawer...');
  const firstRow = page.locator('table tbody tr').first();
  await firstRow.click();
  await page.waitForTimeout(1200);
  await sanitizeAndClean(page);

  console.log('Capturing Slide 6: Event detail drawer...');
  targets.slide6 = { x: 1156, y: 209, width: 410, height: 675 };
  await page.screenshot({ path: path.join(SLIDES_DIR, 'slide_06.png') });

  // Slide 7: Back to Integrations summary
  console.log('Returning to Integrations summary...');
  await page.goto('https://staging.hadrius.com/settings/integrations', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await page.evaluate((top) => {
    const scrollers = document.querySelectorAll('div.overflow-y-auto');
    if (scrollers[1]) scrollers[1].scrollTop = top;
  }, scrollOffset);
  await page.waitForTimeout(600);
  await sanitizeAndClean(page);

  console.log('Capturing Slide 7: Integrations summary...');
  targets.slide7 = { x: 300, y: 520 - scrollOffset, width: 830, height: 220 };
  await page.screenshot({ path: path.join(SLIDES_DIR, 'slide_07.png') });

  await ctx.close();
  console.log('Capture v2 complete! Targets:', targets);
  fs.writeFileSync(path.join(OUT_DIR, 'targets.json'), JSON.stringify(targets, null, 2));
}

run().catch(console.error);
