#!/usr/bin/env python3
"""
Re-assemble all 37 Hadrius Academy videos without the branded intro & outro bumper clips.
Keeps:
  - Title card (intro title slide)
  - Content (walkthrough video with narration, cursors, subtitles, and music)
  - Support card (contact/support slide)
Removes:
  - 3.2s intro video bumper (assets/intro.mp4)
  - 3.5s outro video bumper (assets/outro.mp4)
"""
import os
import sys
import json
import time
import shutil
import subprocess
from pathlib import Path

ITEMS = [
    # Account Surveillance (13)
    ('Account surveillance', 'How to activate, deactivate, or sandbox a surveillance rule.mp4', 'How-to-activate-deactivate-or-sandbox-a-surveillance-rule'),
    ('Account surveillance', 'How to archive a flagged exception.mp4', 'How-to-archive-a-flagged-exception'),
    ('Account surveillance', 'How to bulk-assign or set severity for multiple exceptions.mp4', 'How-to-bulk-assign-or-set-severity-for-multiple-exceptions'),
    ('Account surveillance', 'How to close a flagged compliance exception.mp4', 'How-to-close-a-flagged-compliance-exception'),
    ('Account surveillance', 'How to create a manual exception from selected trades.mp4', 'How-to-create-a-manual-exception-from-selected-trades'),
    ('Account surveillance', 'How to create a new surveillance rule from a template.mp4', 'How-to-create-a-new-surveillance-rule-from-a-template'),
    ('Account surveillance', 'How to edit a surveillance rule\'s configuration.mp4', 'How-to-edit-a-surveillance-rule-s-configuration'),
    ('Account surveillance', 'How to escalate a flagged compliance exception.mp4', 'How-to-escalate-a-flagged-compliance-exception'),
    ('Account surveillance', 'How to manually run a surveillance rule.mp4', 'How-to-manually-run-a-surveillance-rule'),
    ('Account surveillance', 'How to reopen a closed exception in Account surveillance.mp4', 'How-to-reopen-a-closed-exception-in-Account-surveillance'),
    ('Account surveillance', 'How to save and reuse a custom trade search.mp4', 'How-to-save-and-reuse-a-custom-trade-search'),
    ('Account surveillance', 'How to search and filter representatives.mp4', 'How-to-search-and-filter-representatives'),
    ('Account surveillance', 'How to view a rule run\'s results.mp4', 'How-to-view-a-rule-run-s-results'),

    # Branches (3)
    ('Branches', 'How to export a branch exam\'s remediation tracker to CSV.mp4', 'How-to-export-a-branch-exam-s-remediation-tracker-to-CSV'),
    ('Branches', 'How to generate and download a branch exam follow-up letter.mp4', 'How-to-generate-and-download-a-branch-exam-follow-up-letter'),
    ('Branches', 'How to schedule a new branch exam.mp4', 'How-to-schedule-a-new-branch-exam-ai'),

    # Communications (8)
    ('Communications', 'How to add a dataset of filtered communications to a case.mp4', 'How-to-add-a-dataset-of-filtered-communications-to-a-case'),
    ('Communications', 'How to approve or reject pending social media account requests.mp4', 'How-to-approve-or-reject-pending-social-media-account-requests'),
    ('Communications', 'How to create a visibility (information barrier) policy for instant messages.mp4', 'How-to-create-a-visibility-information-barrier-policy-for-instant-messages'),
    ('Communications', 'How to export email search results for a single employee.mp4', 'How-to-export-email-search-results-for-a-single-employee'),
    ('Communications', 'How to export search results for email communications.mp4', 'How-to-export-search-results-for-email-communications-ai'),
    ('Communications', 'How to manage employee access to a case.mp4', 'How-to-manage-employee-access-to-a-case'),
    ('Communications', 'How to rename or delete an export in Settings > Exports.mp4', 'How-to-rename-or-delete-an-export-in-Settings-Exports'),
    ('Communications', 'How to share a case export with an external recipient.mp4', 'How-to-share-a-case-export-with-an-external-recipient'),

    # Marketing (7)
    ('Marketing', 'How to add a new document to an existing marketing project.mp4', 'How-to-add-a-new-document-to-an-existing-marketing-project'),
    ('Marketing', 'How to add context to Firm Intelligence.mp4', 'How-to-add-context-to-Firm-Intelligence'),
    ('Marketing', 'How to configure comment templates for document review.mp4', 'How-to-configure-comment-templates-for-document-review'),
    ('Marketing', 'How to configure marketing document types.mp4', 'How-to-configure-marketing-document-types'),
    ('Marketing', 'How to create a routing rule to auto-assign projects to a workflow.mp4', 'How-to-create-a-routing-rule-to-auto-assign-projects-to-a-workflow'),
    ('Marketing', 'How to create a workflow group.mp4', 'How-to-create-a-workflow-group'),
    ('Marketing', 'How to edit or manage a Firm Intelligence finding.mp4', 'How-to-edit-or-manage-a-Firm-Intelligence-finding'),

    # People Oversight (3)
    ('People oversight', 'How an employee completes and signs a certification.mp4', 'How-an-employee-completes-and-signs-a-certification'),
    ('People oversight', 'How to delete or reject U4 filings in bulk.mp4', 'How-to-delete-or-reject-U4-filings-in-bulk'),
    ('People oversight', 'How to upload or manually enter an employee\'s account holdings.mp4', 'How-to-upload-or-manually-enter-an-employee-s-account-holdings'),

    # Testing Program (3)
    ('Testing program', 'How to archive a policy.mp4', 'How-to-archive-a-policy'),
    ('Testing program', 'How to link a control to a policy section.mp4', 'How-to-link-a-control-to-a-policy-section-ai'),
    ('Testing program', 'How to raise a corrective action during test review.mp4', 'How-to-raise-a-corrective-action-during-test-review'),
]

OUT_BASE = Path('/Users/stephenskalamera/hadrius-studio-beta/out')
DESKTOP_BASE = Path('/Users/stephenskalamera/Desktop/Hadrius Academy')

def get_duration(p: Path) -> float:
    cmd = ['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', str(p)]
    res = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return float(res.stdout.strip())

def crossfade_pair(c1: Path, c2: Path, out_path: Path, xf_dur: float = 0.65) -> bool:
    d1 = get_duration(c1)
    offset = max(0.05, d1 - xf_dur)
    cmd = [
        'ffmpeg', '-y',
        '-i', str(c1),
        '-i', str(c2),
        '-filter_complex',
        f'[0:v][1:v]xfade=transition=fade:duration={xf_dur}:offset={offset:.3f}[v];'
        f'[0:a][1:a]acrossfade=d={xf_dur}[a]',
        '-map', '[v]', '-map', '[a]',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
        str(out_path)
    ]
    subprocess.run(cmd, capture_output=True, check=True)
    return out_path.exists()

def process_video(category: str, filename: str, folder_name: str, index: int, total: int):
    t0 = time.time()
    folder_path = OUT_BASE / folder_name
    build_dir = folder_path / '_build'

    title_clip = build_dir / 'title_card.mp4'
    content_clip = build_dir / 'content.mp4'
    support_clip = build_dir / 'support_card.mp4'

    if not title_clip.exists() or not content_clip.exists() or not support_clip.exists():
        print(f"[{index}/{total}] [ERROR] Missing clips in {build_dir}")
        return False

    tmp_lead_content = build_dir / 'tmp_lead_content.mp4'
    tmp_final = build_dir / 'final_no_bumpers.mp4'

    # Step 1: title -> content
    crossfade_pair(title_clip, content_clip, tmp_lead_content, xf_dur=0.65)

    # Step 2: (title + content) -> support
    crossfade_pair(tmp_lead_content, support_clip, tmp_final, xf_dur=0.65)

    new_dur = get_duration(tmp_final)

    # Clean up intermediate file
    if tmp_lead_content.exists():
        tmp_lead_content.unlink()

    # Destination paths
    out_mp4 = folder_path / f"{folder_name}.mp4"
    desktop_mp4 = DESKTOP_BASE / category / filename

    shutil.copy2(tmp_final, out_mp4)
    desktop_mp4.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(tmp_final, desktop_mp4)

    # Update assembly.json
    assembly_json_path = folder_path / 'assembly.json'
    if assembly_json_path.exists():
        try:
            with open(assembly_json_path, 'r') as f:
                data = json.load(f)
            data['intro'] = False
            data['outro'] = False
            data['duration'] = round(new_dur, 2)
            with open(assembly_json_path, 'w') as f:
                json.dump(data, f, indent=1)
        except Exception as e:
            print(f"    (warning: failed to update assembly.json: {e})")

    elapsed = time.time() - t0
    print(f"[{index}/{total}] ✓ {category} / {filename} ({new_dur:.1f}s) in {elapsed:.1f}s")
    return True

def main():
    print(f"Starting re-assembly of {len(ITEMS)} videos without intro/outro bumpers...")
    total_start = time.time()
    success_count = 0

    for idx, (cat, fname, folder) in enumerate(ITEMS, 1):
        try:
            ok = process_video(cat, fname, folder, idx, len(ITEMS))
            if ok:
                success_count += 1
        except Exception as e:
            print(f"[{idx}/{len(ITEMS)}] ✗ Failed on {folder}: {e}")

    total_time = time.time() - total_start
    print(f"\n=======================================================")
    print(f"Completed {success_count}/{len(ITEMS)} videos in {total_time:.1f}s ({total_time/60:.1f} min)")
    print(f"=======================================================")

if __name__ == '__main__':
    main()
