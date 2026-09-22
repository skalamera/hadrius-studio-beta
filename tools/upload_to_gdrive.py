#!/usr/bin/env python3
import os
import sys
from pathlib import Path
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload
from google.oauth2.credentials import Credentials

TOKEN_PATH = os.path.expanduser('~/.hermes/google_token.json')
LOCAL_DIR = os.path.expanduser('~/Desktop/Hadrius Academy')
PARENT_FOLDER_ID = '1MlLinwFLBprG3Ybz8JAHhuL0V_VubTJr'
OVERWRITE = '--overwrite' in sys.argv or '--update' in sys.argv

if not os.path.exists(TOKEN_PATH):
    print(f"Error: Token not found at {TOKEN_PATH}")
    sys.exit(1)

creds = Credentials.from_authorized_user_file(TOKEN_PATH)
service = build('drive', 'v3', credentials=creds)

# Get existing module folders under Hadrius Academy
res = service.files().list(
    q=f"'{PARENT_FOLDER_ID}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
    fields='files(id, name)'
).execute()

gdrive_folders = {f['name'].lower(): (f['id'], f['name']) for f in res.get('files', [])}
print("Found Google Drive folders:")
for name_lower, (fid, orig_name) in gdrive_folders.items():
    print(f"  - {orig_name}: {fid}")

# Map local module folder names to Google Drive folder IDs
total_uploaded = 0
total_skipped = 0

for local_module in sorted(os.listdir(LOCAL_DIR)):
    local_module_path = os.path.join(LOCAL_DIR, local_module)
    if not os.path.isdir(local_module_path):
        continue

    norm_module = local_module.lower().strip()
    match = gdrive_folders.get(norm_module)
    if not match:
        print(f"\n[!] Warning: No matching Google Drive folder found for '{local_module}'")
        continue

    folder_id, folder_name = match
    print(f"\n=======================================================")
    print(f"Uploading module: {folder_name} (local: '{local_module}')")
    print(f"=======================================================")

    # List existing files in this Google Drive folder
    existing_res = service.files().list(
        q=f"'{folder_id}' in parents and trashed = false",
        fields='files(id, name, size)'
    ).execute()
    existing_names = {f['name']: f['id'] for f in existing_res.get('files', [])}

    files = [f for f in sorted(os.listdir(local_module_path)) if f.endswith('.mp4')]
    for filename in files:
        filepath = os.path.join(local_module_path, filename)
        filesize_mb = os.path.getsize(filepath) / (1024 * 1024)

        if filename in existing_names:
            if not OVERWRITE:
                print(f"  [SKIP] '{filename}' already exists in {folder_name}")
                total_skipped += 1
                continue
            else:
                file_id = existing_names[filename]
                print(f"  [UPDATE] '{filename}' ({filesize_mb:.1f} MB)...", end='', flush=True)
                media = MediaFileUpload(filepath, mimetype='video/mp4', resumable=True)
                request = service.files().update(fileId=file_id, media_body=media, fields='id, name')
                response = None
                while response is None:
                    status, response = request.next_chunk()
                    if status:
                        print(f".", end='', flush=True)
                print(f" ✓ Updated (ID: {response.get('id')})")
                total_uploaded += 1
                continue

        print(f"  [UPLOAD] '{filename}' ({filesize_mb:.1f} MB)...", end='', flush=True)
        media = MediaFileUpload(filepath, mimetype='video/mp4', resumable=True)
        file_metadata = {
            'name': filename,
            'parents': [folder_id]
        }

        request = service.files().create(body=file_metadata, media_body=media, fields='id, name')
        response = None
        while response is None:
            status, response = request.next_chunk()
            if status:
                print(f".", end='', flush=True)

        print(f" ✓ Done (ID: {response.get('id')})")
        total_uploaded += 1

print(f"\n=======================================================")
print(f"Finished! Total uploaded: {total_uploaded}, Skipped (already existed): {total_skipped}")
print(f"=======================================================")
