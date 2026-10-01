/**
 * Batch update all Hadrius Academy Pylon KB articles with the latest videos
 * from Google Drive folder 1fYjVjmRG1wgh4v1FF3EpdAdC5oN-LFcP.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pylonUploadAttachment, PYLON_KNOWLEDGE_BASE_ID } from './pylon.mjs';

const REPO_ROOT = path.resolve('.');
const KB_ID = PYLON_KNOWLEDGE_BASE_ID;
const TOKEN = process.env.PYLON_API_TOKEN;
const PROGRESS_FILE = path.join(REPO_ROOT, '.hermes', 'pylon_update_progress.json');

const SEARCH_DIRS = [
  '/Users/stephenskalamera/Desktop/Circle',
  '/Users/stephenskalamera/Downloads/ginas_extra_vids',
  path.join(REPO_ROOT, 'out')
];

function norm(s) {
  if (!s) return '';
  return s.toLowerCase().replace('.mp4', '').replace(/[^a-z0-9]+/g, '');
}

// Build index of all local mp4 files
console.log('Indexing local MP4 files...');
const localFiles = new Map();
for (const sdir of SEARCH_DIRS) {
  if (!fs.existsSync(sdir)) continue;
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!ent.name.startsWith('.')) walk(full);
      } else if (ent.isFile() && ent.name.endsWith('.mp4') && !ent.name.startsWith('.')) {
        const k = norm(ent.name);
        if (!localFiles.has(k)) {
          localFiles.set(k, full);
        }
      }
    }
  }
  walk(sdir);
}
console.log(`Found ${localFiles.size} unique local MP4 files.`);

async function main() {
  const matchesPath = path.join(REPO_ROOT, '.hermes', 'final_article_matches.json');
  if (!fs.existsSync(matchesPath)) {
    console.error(`Matches file ${matchesPath} not found!`);
    process.exit(1);
  }

  const matches = JSON.parse(fs.readFileSync(matchesPath, 'utf8'));
  console.log(`Loaded ${matches.length} matched articles to update.\n`);

  let progress = {};
  if (fs.existsSync(PROGRESS_FILE)) {
    try {
      progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
    } catch (_) {}
  }

  const uploadedCache = new Map();
  let updatedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (let i = 0; i < matches.length; i++) {
    const { article, drive_file, match_source } = matches[i];
    const artId = article.id;
    const artTitle = article.title;
    const driveName = drive_file.name;
    const progressKey = artId;

    if (progress[progressKey]?.completed) {
      console.log(`[${i + 1}/${matches.length}] Already completed: "${artTitle}"`);
      skippedCount++;
      continue;
    }

    console.log(`\n=======================================================`);
    console.log(`[${i + 1}/${matches.length}] Processing article: "${artTitle}"`);
    console.log(`Matched Drive video: "${driveName}" (match source: ${match_source})`);

    // 1. Locate local MP4
    const cleanDrive = norm(driveName);
    const localMp4 = localFiles.get(cleanDrive);
    if (!localMp4 || !fs.existsSync(localMp4)) {
      console.error(`  ✗ Error: Local video for "${driveName}" not found on disk!`);
      errorCount++;
      continue;
    }
    console.log(`  Local MP4: ${localMp4}`);

    try {
      // 2. Upload attachment if not already cached
      let cdnUrl = uploadedCache.get(localMp4);
      if (!cdnUrl) {
        console.log(`  Uploading attachment to Pylon CDN...`);
        const att = await pylonUploadAttachment(localMp4, 'Video walkthrough');
        cdnUrl = att.url;
        uploadedCache.set(localMp4, cdnUrl);
        console.log(`  ✓ Uploaded to CDN: ${cdnUrl.slice(0, 80)}...`);
      } else {
        console.log(`  ✓ Reusing cached CDN URL for this file.`);
      }

      // 3. Fetch current article content
      const artResp = await fetch(`https://api.usepylon.com/knowledge-bases/${KB_ID}/articles/${artId}`, {
        headers: { Authorization: `Bearer ${TOKEN}` }
      });
      if (!artResp.ok) {
        throw new Error(`Failed to fetch article ${artId}: HTTP ${artResp.status}`);
      }
      const artData = await artResp.json();
      const currentArt = artData.data;
      const currentHtml = currentArt.current_published_content_html || currentArt.current_draft_content_html || '';

      // 4. Construct updated HTML
      let updatedHtml = currentHtml;
      const videoTagRegex = /<video[^>]+src="([^">]+)"[^>]*>[\s\S]*?<\/video>|<video[^>]+src="([^">]+)"[^>]*>/i;
      const match = updatedHtml.match(videoTagRegex);

      const newVideoTag = `<video src="${cdnUrl}" data-width="100%" alt="${driveName}" title="${driveName}" class="kb-video" controls="true" preload="metadata"></video>`;

      if (match) {
        updatedHtml = updatedHtml.replace(match[0], newVideoTag);
      } else {
        // Prepend video at top of article
        updatedHtml = newVideoTag + '\n' + updatedHtml;
      }

      // 5. Submit PATCH
      console.log(`  Submitting PATCH to Pylon for article ${artId}...`);
      const patchResp = await fetch(`https://api.usepylon.com/knowledge-bases/${KB_ID}/articles/${artId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ body_html: updatedHtml })
      });

      if (!patchResp.ok) {
        const errText = await patchResp.text();
        throw new Error(`PATCH failed: HTTP ${patchResp.status} - ${errText}`);
      }

      console.log(`  ✓ Successfully updated article "${artTitle}"`);
      progress[progressKey] = {
        completed: true,
        article_id: artId,
        article_title: artTitle,
        drive_file: driveName,
        cdn_url: cdnUrl,
        updated_at: new Date().toISOString()
      };
      fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
      updatedCount++;

      // Small delay between requests to be gentle on Pylon API
      await new Promise(r => setTimeout(r, 600));

    } catch (err) {
      console.error(`  ✗ Error updating article "${artTitle}":`, err.message);
      progress[progressKey] = {
        completed: false,
        error: err.message
      };
      fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
      errorCount++;
    }
  }

  console.log(`\n=======================================================`);
  console.log(`PYLON KB UPDATE COMPLETE!`);
  console.log(`- Updated: ${updatedCount}`);
  console.log(`- Skipped (already completed): ${skippedCount}`);
  console.log(`- Errors: ${errorCount}`);
  console.log(`- Total: ${matches.length}`);
}

main().catch(console.error);
