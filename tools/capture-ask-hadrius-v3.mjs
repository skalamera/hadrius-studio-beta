import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const OUT_DIR = path.resolve('out/Ask-Hadrius-AI-Walkthrough');
const SLIDES_DIR = path.join(OUT_DIR, 'slides');
const CHROME_PROFILE_DIR = '/tmp/chrome_test_root_frames';

fs.mkdirSync(SLIDES_DIR, { recursive: true });

async function run() {
  console.log('Launching browser to capture Ask Hadrius walkthrough with drawer scroll...');
  const ctx = await chromium.launchPersistentContext(CHROME_PROFILE_DIR, {
    headless: true,
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor: 1
  });

  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);

  // Navigate to Overview
  console.log('Navigating to overview...');
  await page.goto('https://staging.hadrius.com/overview', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  // Slide 1: Overview page before opening Ask Hadrius
  console.log('Capturing Slide 1 (Overview)...');
  await page.screenshot({ path: path.join(SLIDES_DIR, 'slide_01.png') });

  // Open Ask Hadrius
  console.log('Opening Ask Hadrius drawer...');
  const askBtn = page.getByRole('button', { name: /ask hadrius/i }).or(page.locator('button:has-text("Ask Hadrius")'));
  await askBtn.first().click();
  await page.waitForTimeout(2000);

  // Helper to record drawer scrolling
  async function recordDrawerScroll(outMp4, targetDur = 12.0) {
    // Scroll to top
    await page.evaluate(() => {
      const el = document.querySelector('aside .h-shell-scrollbars');
      if (el) el.scrollTop = 0;
    });
    await page.waitForTimeout(400);

    const scrollInfo = await page.evaluate(() => {
      const el = document.querySelector('aside .h-shell-scrollbars');
      if (!el) return null;
      return {
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        maxScroll: el.scrollHeight - el.clientHeight
      };
    });
    console.log('Ask Hadrius drawer scroll info:', scrollInfo);
    const maxScroll = scrollInfo ? scrollInfo.maxScroll : 0;

    const tmpDir = path.join(path.dirname(outMp4), `_tmp_frames_${path.basename(outMp4, '.mp4')}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    const steps = 30;
    const ease = (t) => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;

    for (let i = 0; i <= steps; i++) {
      const pos = ease(i / steps) * maxScroll;
      await page.evaluate((top) => {
        const el = document.querySelector('aside .h-shell-scrollbars');
        if (el) el.scrollTop = top;
      }, pos);
      await page.screenshot({ path: path.join(tmpDir, `frame_${String(i).padStart(3, '0')}.png`) });
    }

    // Build video using ffmpeg
    // 0 to 2.5s (75 frames): hold frame_000 (top)
    // 2.5 to 8.0s (165 frames): smoothly step through frame_000 to frame_030
    // 8.0 to 12.0s (120 frames): hold frame_030 (bottom)
    const listFile = path.join(tmpDir, 'concat.txt');
    const lines = [];

    // Hold top 2.5s
    for (let f = 0; f < 75; f++) {
      lines.push(`file '${path.join(tmpDir, 'frame_000.png')}'`);
      lines.push('duration 0.033333');
    }
    // Scroll 5.5s
    const scrollFrames = 165;
    for (let f = 0; f < scrollFrames; f++) {
      const frameIdx = Math.min(steps, Math.floor((f / scrollFrames) * (steps + 1)));
      lines.push(`file '${path.join(tmpDir, `frame_${String(frameIdx).padStart(3, '0')}.png`)}'`);
      lines.push('duration 0.033333');
    }
    // Hold bottom 4.0s
    for (let f = 0; f < 120; f++) {
      lines.push(`file '${path.join(tmpDir, `frame_${String(steps).padStart(3, '0')}.png`)}'`);
      lines.push('duration 0.033333');
    }
    lines.push(`file '${path.join(tmpDir, `frame_${String(steps).padStart(3, '0')}.png`)}'`);

    fs.writeFileSync(listFile, lines.join('\n'));

    console.log(`Assembling ${outMp4} from frames...`);
    execSync(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -vf "fps=30" -c:v libx264 -pix_fmt yuv420p "${outMp4}"`, { stdio: 'inherit' });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log(`Finished ${outMp4}`);
  }

  // --- QUESTION 1 ---
  const q1 = "What compliance items currently require immediate attention across the firm?";
  console.log('Typing Question 1...');
  const textarea = page.locator('aside textarea, aside input[placeholder*="Ask"]').first();
  await textarea.fill(q1);
  await page.waitForTimeout(500);

  // Slide 2: Question 1 typed in drawer
  console.log('Capturing Slide 2 (Q1 typed)...');
  await page.screenshot({ path: path.join(SLIDES_DIR, 'slide_02.png') });

  // Submit Q1
  console.log('Submitting Question 1...');
  const sendBtn = page.locator('aside button[aria-label="Send message"], aside button:has(svg.lucide-arrow-up)').first();
  await sendBtn.click();

  // Wait for Q1 response to finish
  console.log('Waiting for Q1 response...');
  for (let i = 0; i < 35; i++) {
    const text = await page.evaluate(() => document.querySelector('aside')?.innerText || '');
    if (text.includes('Key Observations') || text.includes('Advisors') || text.includes('Gifts & Entertainment')) {
      console.log('Q1 response complete!');
      break;
    }
    await page.waitForTimeout(1500);
  }
  await page.waitForTimeout(2000);

  // Slide 3: Smooth drawer scroll through Q1 response!
  console.log('Recording Slide 3 (Q1 drawer scroll)...');
  await recordDrawerScroll(path.join(SLIDES_DIR, 'slide_03.mp4'), 12.0);

  // --- QUESTION 2 ---
  console.log('Starting Question 2 (Clicking New chat)...');
  const newChatBtn = page.locator('aside button[aria-label="New chat"]').first();
  await newChatBtn.click();
  await page.waitForTimeout(1000);

  const q2 = "Which employees have pending disclosures awaiting review, and what types of disclosures are they?";
  console.log('Typing Question 2...');
  const textarea2 = page.locator('aside textarea, aside input[placeholder*="Ask"]').first();
  await textarea2.fill(q2);
  await page.waitForTimeout(500);

  // Slide 4: Question 2 typed in drawer
  console.log('Capturing Slide 4 (Q2 typed)...');
  await page.screenshot({ path: path.join(SLIDES_DIR, 'slide_04.png') });

  // Submit Q2
  console.log('Submitting Question 2...');
  const sendBtn2 = page.locator('aside button[aria-label="Send message"], aside button:has(svg.lucide-arrow-up)').first();
  await sendBtn2.click();

  // Wait for Q2 response to finish
  console.log('Waiting for Q2 response...');
  for (let i = 0; i < 35; i++) {
    const text = await page.evaluate(() => document.querySelector('aside')?.innerText || '');
    if (text.includes('Key Observations') || text.includes('FINRA') || text.includes('Adrian Sosa')) {
      console.log('Q2 response complete!');
      break;
    }
    await page.waitForTimeout(1500);
  }
  await page.waitForTimeout(2000);

  // Slide 5: Smooth drawer scroll through Q2 response!
  console.log('Recording Slide 5 (Q2 drawer scroll)...');
  await recordDrawerScroll(path.join(SLIDES_DIR, 'slide_05.mp4'), 11.0);

  // --- QUESTION 3 ---
  console.log('Starting Question 3 (Clicking New chat)...');
  const newChatBtn2 = page.locator('aside button[aria-label="New chat"]').first();
  await newChatBtn2.click();
  await page.waitForTimeout(1000);

  const q3 = "Summarize our active and overdue compliance certification campaigns and what needs review.";
  console.log('Typing Question 3...');
  const textarea3 = page.locator('aside textarea, aside input[placeholder*="Ask"]').first();
  await textarea3.fill(q3);
  await page.waitForTimeout(500);

  // Slide 6: Question 3 typed in drawer
  console.log('Capturing Slide 6 (Q3 typed)...');
  await page.screenshot({ path: path.join(SLIDES_DIR, 'slide_06.png') });

  // Submit Q3
  console.log('Submitting Question 3...');
  const sendBtn3 = page.locator('aside button[aria-label="Send message"], aside button:has(svg.lucide-arrow-up)').first();
  await sendBtn3.click();

  // Wait for Q3 response to finish
  console.log('Waiting for Q3 response...');
  for (let i = 0; i < 35; i++) {
    const text = await page.evaluate(() => document.querySelector('aside')?.innerText || '');
    if (text.includes('Key Observations') || text.includes('Quarterly Compliance') || text.includes('Erik Andersson')) {
      console.log('Q3 response complete!');
      break;
    }
    await page.waitForTimeout(1500);
  }
  await page.waitForTimeout(2000);

  // Slide 7: Smooth drawer scroll through Q3 response!
  console.log('Recording Slide 7 (Q3 drawer scroll)...');
  await recordDrawerScroll(path.join(SLIDES_DIR, 'slide_07.mp4'), 10.5);

  // Slide 8: Closing overview with conversation intact
  console.log('Capturing Slide 8 (Summary)...');
  await page.evaluate(() => {
    const el = document.querySelector('aside .h-shell-scrollbars');
    if (el) el.scrollTop = 0;
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SLIDES_DIR, 'slide_08.png') });

  console.log('All slides and drawer scroll videos captured successfully!');
  await ctx.close();
}

run().catch((err) => {
  console.error('Capture failed:', err);
  process.exit(1);
});
