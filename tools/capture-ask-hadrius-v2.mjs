import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const OUT_DIR = path.resolve('out/Ask-Hadrius-AI-Walkthrough');
const SLIDES_DIR = path.join(OUT_DIR, 'slides');
fs.mkdirSync(SLIDES_DIR, { recursive: true });

async function waitForAskHadriusResponse(page, maxWaitSec = 60) {
  console.log('Waiting for Ask Hadrius response...');
  for (let i = 0; i < maxWaitSec / 2; i++) {
    await page.waitForTimeout(2000);
    const isBusy = await page.evaluate(() => {
      const stopBtn = document.querySelector('button[aria-label="Stop"]:not([disabled])');
      const hasWorking = document.body.innerText.includes('Ask Hadrius: Working') ||
                         document.body.innerText.includes('Searching records') ||
                         document.body.innerText.includes('Thinking...');
      return !!stopBtn || hasWorking;
    });
    if (!isBusy && i > 3) {
      console.log(`Response completed in ${(i + 1) * 2}s`);
      await page.waitForTimeout(2000);
      return;
    }
  }
}

async function captureScrollVideo(page, slideNum, durSec = 7.5) {
  console.log(`Capturing smooth scroll for slide ${slideNum}...`);
  // First ensure scrollTop is 0
  await page.evaluate(() => {
    const el = document.querySelector('.overflow-y-auto');
    if (el) el.scrollTop = 0;
  });
  await page.waitForTimeout(500);

  const scrollInfo = await page.evaluate(() => {
    const el = document.querySelector('.overflow-y-auto');
    return el ? { maxScroll: el.scrollHeight - el.clientHeight } : { maxScroll: 0 };
  });
  console.log(`Slide ${slideNum} maxScroll:`, scrollInfo.maxScroll);

  const tmpFramesDir = `/tmp/scroll_frames_slide_${slideNum}`;
  if (fs.existsSync(tmpFramesDir)) fs.rmSync(tmpFramesDir, { recursive: true });
  fs.mkdirSync(tmpFramesDir, { recursive: true });

  const numSteps = 24;
  for (let i = 0; i <= numSteps; i++) {
    const progress = i / numSteps;
    // easeInOutCubic
    const ease = progress < 0.5 ? 4 * progress * progress * progress : 1 - Math.pow(-2 * progress + 2, 3) / 2;
    const pos = Math.round(scrollInfo.maxScroll * ease);
    await page.evaluate((p) => {
      const el = document.querySelector('.overflow-y-auto');
      if (el) el.scrollTop = p;
    }, pos);
    await page.screenshot({ path: path.join(tmpFramesDir, `step_${String(i).padStart(3, '0')}.png`) });
  }

  // Also save the top frame as the slide_XX.png fallback
  fs.copyFileSync(path.join(tmpFramesDir, 'step_000.png'), path.join(SLIDES_DIR, `slide_${String(slideNum).padStart(2, '0')}.png`));

  // Assemble into smooth MP4 using python script or ffmpeg
  const animDir = `/tmp/scroll_anim_slide_${slideNum}`;
  if (fs.existsSync(animDir)) fs.rmSync(animDir, { recursive: true });
  fs.mkdirSync(animDir, { recursive: true });

  const totalFrames = Math.round(durSec * 30);
  const holdTopFrames = Math.round(2.0 * 30); // 60 frames
  const holdBottomFrames = Math.round(2.0 * 30); // 60 frames
  const scrollAnimFrames = totalFrames - holdTopFrames - holdBottomFrames; // remainder

  let frameIdx = 0;
  const f0 = path.join(tmpFramesDir, 'step_000.png');
  for (let i = 0; i < holdTopFrames; i++) {
    fs.copyFileSync(f0, path.join(animDir, `f_${String(frameIdx++).padStart(4, '0')}.png`));
  }
  for (let i = 0; i < scrollAnimFrames; i++) {
    const stepIdx = Math.round((i / (scrollAnimFrames - 1)) * numSteps);
    const fi = path.join(tmpFramesDir, `step_${String(stepIdx).padStart(3, '0')}.png`);
    fs.copyFileSync(fi, path.join(animDir, `f_${String(frameIdx++).padStart(4, '0')}.png`));
  }
  const fLast = path.join(tmpFramesDir, `step_${String(numSteps).padStart(3, '0')}.png`);
  for (let i = 0; i < holdBottomFrames; i++) {
    fs.copyFileSync(fLast, path.join(animDir, `f_${String(frameIdx++).padStart(4, '0')}.png`));
  }

  const outMp4 = path.join(SLIDES_DIR, `slide_${String(slideNum).padStart(2, '0')}.mp4`);
  execSync(`ffmpeg -y -framerate 30 -i "${animDir}/f_%04d.png" -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p -r 30 "${outMp4}"`, { stdio: 'inherit' });
  console.log(`Saved slide video: ${outMp4}`);
}

async function run() {
  const root = '/tmp/chrome_test_root_v2';
  const src = '/Users/stephenskalamera/Library/Application Support/Google/Chrome/Profile 2';
  const def = path.join(root, 'Default');
  fs.mkdirSync(def, { recursive: true });
  for (const item of ['Cookies', 'Network', 'Local Storage', 'Preferences', 'Secure Preferences']) {
    const s = path.join(src, item);
    const d = path.join(def, item);
    if (fs.existsSync(s)) {
      if (fs.statSync(s).isDirectory()) fs.cpSync(s, d, { recursive: true });
      else fs.copyFileSync(s, d);
    }
  }

  const ctx = await chromium.launchPersistentContext(root, {
    channel: 'chrome',
    headless: true,
    viewport: { width: 1600, height: 900 },
  });

  const page = ctx.pages()[0] || await ctx.newPage();
  console.log('Navigating to staging.hadrius.com/overview...');
  await page.goto('https://staging.hadrius.com/overview', { timeout: 30000, waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  // Impersonate Stephen Skalamera
  const empBtn = page.locator('button:has-text("Unknown employee"), button:has-text("employee")').first();
  if (await empBtn.isVisible()) {
    console.log('Impersonating Stephen Skalamera...');
    await empBtn.click();
    await page.waitForTimeout(1000);
    const searchInput = page.locator('input[placeholder*="Search employee"]').first();
    await searchInput.fill('stephen@hadrius.com');
    await page.waitForTimeout(1000);
    const opt = page.locator('div, button, li').filter({ hasText: 'stephen@hadrius.com' }).last();
    await opt.click();
    await page.waitForTimeout(3000);
  }

  // SLIDE 1: Overview with Ask Hadrius button
  console.log('Capturing Slide 1...');
  const askBtn = page.locator('button:has-text("Ask Hadrius")').first();
  const askBox = await askBtn.boundingBox();
  await page.screenshot({ path: path.join(SLIDES_DIR, 'slide_01.png') });

  // Open Ask Hadrius
  await askBtn.click();
  await page.waitForTimeout(2000);

  // SLIDE 2: Typing Question 1
  console.log('Capturing Slide 2: Typing Question 1...');
  const q1Text = 'What compliance items currently require immediate attention across the firm?';
  const textarea = page.locator('textarea[placeholder*="Ask Hadrius"]').first();
  await textarea.click();
  await textarea.fill(q1Text);
  await page.waitForTimeout(800);
  const taBox = await textarea.boundingBox();
  await page.screenshot({ path: path.join(SLIDES_DIR, 'slide_02.png') });

  // Submit Q1
  console.log('Submitting Question 1...');
  await page.keyboard.press('Enter');
  await waitForAskHadriusResponse(page, 50);

  // SLIDE 3: Scroll through Q1 response
  await captureScrollVideo(page, 3, 7.5);

  // New Chat
  const newChatBtn = page.locator('button[aria-label="New chat"]').first();
  if (await newChatBtn.isVisible()) {
    await newChatBtn.click();
    await page.waitForTimeout(1500);
  }

  // SLIDE 4: Typing Question 2
  console.log('Capturing Slide 4: Typing Question 2...');
  const q2Text = 'Which employees have pending disclosures awaiting review, and what types of disclosures are they?';
  const textarea2 = page.locator('textarea[placeholder*="Ask Hadrius"]').first();
  await textarea2.click();
  await textarea2.fill(q2Text);
  await page.waitForTimeout(800);
  const taBox2 = await textarea2.boundingBox();
  await page.screenshot({ path: path.join(SLIDES_DIR, 'slide_04.png') });

  // Submit Q2
  console.log('Submitting Question 2...');
  await page.keyboard.press('Enter');
  await waitForAskHadriusResponse(page, 50);

  // SLIDE 5: Scroll through Q2 response
  await captureScrollVideo(page, 5, 7.5);

  // New Chat
  if (await newChatBtn.isVisible()) {
    await newChatBtn.click();
    await page.waitForTimeout(1500);
  }

  // SLIDE 6: Typing Question 3
  console.log('Capturing Slide 6: Typing Question 3...');
  const q3Text = 'Summarize our active and overdue compliance certification campaigns and what needs review.';
  const textarea3 = page.locator('textarea[placeholder*="Ask Hadrius"]').first();
  await textarea3.click();
  await textarea3.fill(q3Text);
  await page.waitForTimeout(800);
  const taBox3 = await textarea3.boundingBox();
  await page.screenshot({ path: path.join(SLIDES_DIR, 'slide_06.png') });

  // Submit Q3
  console.log('Submitting Question 3...');
  await page.keyboard.press('Enter');
  await waitForAskHadriusResponse(page, 50);

  // SLIDE 7: Scroll through Q3 response
  await captureScrollVideo(page, 7, 7.5);

  // SLIDE 8: Closing overview
  console.log('Capturing Slide 8...');
  await page.screenshot({ path: path.join(SLIDES_DIR, 'slide_08.png') });

  console.log('All slides and scroll videos captured successfully!');
  await ctx.close();
}

run().catch((e) => {
  console.error('Error:', e);
  process.exit(1);
});
