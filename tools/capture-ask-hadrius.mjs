import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

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
      await page.waitForTimeout(2000); // extra settle time
      return;
    }
  }
  console.log('Wait finished (max wait reached or complete)');
}

async function run() {
  const root = '/tmp/chrome_test_root';
  const ctx = await chromium.launchPersistentContext(root, {
    channel: 'chrome',
    headless: true,
    viewport: { width: 1600, height: 900 },
  });

  const page = ctx.pages()[0] || await ctx.newPage();
  console.log('Navigating to staging.hadrius.com/overview...');
  await page.goto('https://staging.hadrius.com/overview', { timeout: 30000, waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  // 1. Ensure Hadrius Sandbox and Impersonate Stephen Skalamera
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

  const slides = [];

  // SLIDE 1: Overview with Ask Hadrius button highlighted
  console.log('Capturing Slide 1: Overview with Ask Hadrius button...');
  const askBtn = page.locator('button:has-text("Ask Hadrius")').first();
  const askBox = await askBtn.boundingBox();
  await page.screenshot({ path: path.join(SLIDES_DIR, 'slide_01.png') });
  slides.push({
    slide: 1,
    file: 'slide_01.png',
    narration: "Ask Hadrius serves as the platform's AI compliance assistant, giving compliance officers instant visibility across the firm.",
    caption: "Ask Hadrius serves as the platform's AI compliance assistant, giving compliance officers instant visibility across the firm.",
    target: askBox ? { x: Math.round(askBox.x), y: Math.round(askBox.y), width: Math.round(askBox.width), height: Math.round(askBox.height) } : null,
    viewport: { width: 1600, height: 900 },
    route: '/overview',
  });

  // Open Ask Hadrius
  await askBtn.click();
  await page.waitForTimeout(2000);

  // SLIDE 2: Question 1 typed in textarea
  console.log('Capturing Slide 2: Typing Question 1...');
  const q1Text = 'What compliance items currently require immediate attention across the firm?';
  const textarea = page.locator('textarea[placeholder*="Ask Hadrius"]').first();
  await textarea.click();
  await textarea.fill(q1Text);
  await page.waitForTimeout(800);
  const taBox = await textarea.boundingBox();
  await page.screenshot({ path: path.join(SLIDES_DIR, 'slide_02.png') });
  slides.push({
    slide: 2,
    file: 'slide_02.png',
    narration: 'First, we can ask for a firm-wide pulse check on overdue compliance items and unresolved risks.',
    caption: 'First, we can ask for a firm-wide pulse check on overdue compliance items and unresolved risks.',
    target: taBox ? { x: Math.round(taBox.x), y: Math.round(taBox.y), width: Math.round(taBox.width), height: Math.round(taBox.height) } : null,
    viewport: { width: 1600, height: 900 },
    route: '/overview',
  });

  // Submit Q1 and wait for response
  console.log('Submitting Question 1...');
  await page.keyboard.press('Enter');
  await waitForAskHadriusResponse(page, 50);

  // SLIDE 3: Question 1 response complete
  console.log('Capturing Slide 3: Question 1 response...');
  await page.screenshot({ path: path.join(SLIDES_DIR, 'slide_03.png') });
  slides.push({
    slide: 3,
    file: 'slide_03.png',
    narration: 'The assistant synthesizes open findings and past-due test runs, pinpointing critical compliance exposure in seconds.',
    caption: 'The assistant synthesizes open findings and past-due test runs, pinpointing critical compliance exposure in seconds.',
    target: null,
    viewport: { width: 1600, height: 900 },
    route: '/overview',
  });

  // Click New Chat for Question 2
  console.log('Starting new chat for Question 2...');
  const newChatBtn = page.locator('button[aria-label="New chat"]').first();
  if (await newChatBtn.isVisible()) {
    await newChatBtn.click();
    await page.waitForTimeout(1500);
  }

  // SLIDE 4: Question 2 typed in textarea
  console.log('Capturing Slide 4: Typing Question 2...');
  const q2Text = 'Which employees have pending disclosures awaiting review, and what types of disclosures are they?';
  const textarea2 = page.locator('textarea[placeholder*="Ask Hadrius"]').first();
  await textarea2.click();
  await textarea2.fill(q2Text);
  await page.waitForTimeout(800);
  const taBox2 = await textarea2.boundingBox();
  await page.screenshot({ path: path.join(SLIDES_DIR, 'slide_04.png') });
  slides.push({
    slide: 4,
    file: 'slide_04.png',
    narration: 'Next, we can query employee oversight to inspect pending personal disclosures across all staff.',
    caption: 'Next, we can query employee oversight to inspect pending personal disclosures across all staff.',
    target: taBox2 ? { x: Math.round(taBox2.x), y: Math.round(taBox2.y), width: Math.round(taBox2.width), height: Math.round(taBox2.height) } : null,
    viewport: { width: 1600, height: 900 },
    route: '/overview',
  });

  // Submit Q2 and wait for response
  console.log('Submitting Question 2...');
  await page.keyboard.press('Enter');
  await waitForAskHadriusResponse(page, 50);

  // SLIDE 5: Question 2 response complete
  console.log('Capturing Slide 5: Question 2 response...');
  await page.screenshot({ path: path.join(SLIDES_DIR, 'slide_05.png') });
  slides.push({
    slide: 5,
    file: 'slide_05.png',
    narration: 'It automatically structures pending filings into categories and flags outside business activities that require a regulatory filing.',
    caption: 'It automatically structures pending filings into categories and flags outside business activities that require a regulatory filing.',
    target: null,
    viewport: { width: 1600, height: 900 },
    route: '/overview',
  });

  // Click New Chat for Question 3
  console.log('Starting new chat for Question 3...');
  if (await newChatBtn.isVisible()) {
    await newChatBtn.click();
    await page.waitForTimeout(1500);
  }

  // SLIDE 6: Question 3 typed in textarea
  console.log('Capturing Slide 6: Typing Question 3...');
  const q3Text = 'Summarize our active and overdue compliance certification campaigns and what needs review.';
  const textarea3 = page.locator('textarea[placeholder*="Ask Hadrius"]').first();
  await textarea3.click();
  await textarea3.fill(q3Text);
  await page.waitForTimeout(800);
  const taBox3 = await textarea3.boundingBox();
  await page.screenshot({ path: path.join(SLIDES_DIR, 'slide_06.png') });
  slides.push({
    slide: 6,
    file: 'slide_06.png',
    narration: 'Finally, we can evaluate firm-wide compliance certifications and track employee completion rates.',
    caption: 'Finally, we can evaluate firm-wide compliance certifications and track employee completion rates.',
    target: taBox3 ? { x: Math.round(taBox3.x), y: Math.round(taBox3.y), width: Math.round(taBox3.width), height: Math.round(taBox3.height) } : null,
    viewport: { width: 1600, height: 900 },
    route: '/overview',
  });

  // Submit Q3 and wait for response
  console.log('Submitting Question 3...');
  await page.keyboard.press('Enter');
  await waitForAskHadriusResponse(page, 50);

  // SLIDE 7: Question 3 response complete
  console.log('Capturing Slide 7: Question 3 response...');
  await page.screenshot({ path: path.join(SLIDES_DIR, 'slide_07.png') });
  slides.push({
    slide: 7,
    file: 'slide_07.png',
    narration: 'Ask Hadrius highlights overdue campaigns and isolates flagged questionnaires requiring manual sign-off before closing.',
    caption: 'Ask Hadrius highlights overdue campaigns and isolates flagged questionnaires requiring manual sign-off before closing.',
    target: null,
    viewport: { width: 1600, height: 900 },
    route: '/overview',
  });

  // SLIDE 8: Closing overview
  console.log('Capturing Slide 8: Closing summary...');
  await page.screenshot({ path: path.join(SLIDES_DIR, 'slide_08.png') });
  slides.push({
    slide: 8,
    file: 'slide_08.png',
    narration: 'In just sixty seconds, Ask Hadrius turns complex compliance records into clear, actionable intelligence.',
    caption: 'In just sixty seconds, Ask Hadrius turns complex compliance records into clear, actionable intelligence.',
    target: null,
    viewport: { width: 1600, height: 900 },
    route: '/overview',
  });

  // Write report.json
  const report = {
    name: 'Ask-Hadrius-AI-Walkthrough',
    title: 'Ask Hadrius AI Assistant',
    module: 'Platform',
    source: 'recording',
    startedAt: new Date().toISOString(),
    slides,
  };

  fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  console.log('Done capturing! report.json and 8 slides saved to:', OUT_DIR);

  await ctx.close();
}

run().catch((e) => {
  console.error('Error:', e);
  process.exit(1);
});
