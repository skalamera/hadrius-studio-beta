# Hadrius Studio Slack app — setup

The weekly drift check posts to channel `C0CD42Y6RU6` and takes Approve/Deny clicks through the
"Hadrius Studio" Slack app. Secrets are set by you directly in Vercel and in the Studio `.env`;
nobody should paste them into chat.

## 1. Create and install the app

1. Go to https://api.slack.com/apps → **Create New App** → **From an app manifest**.
2. Pick the Hadrius workspace.
3. Paste the contents of `tools/drift/slack-app-manifest.yml` (YAML tab) → **Next** → **Create**.
4. **Install to Workspace** → **Allow**. (If your workspace requires admin approval, request it.)

## 2. Invite the bot to the channel

In Slack, open channel `C0CD42Y6RU6` and run:

    /invite @Hadrius Studio

## 3. Copy the two values (don't paste them anywhere else)

- **Bot token**: app settings → **OAuth & Permissions** → *Bot User OAuth Token* (starts with `xoxb-`).
- **Signing secret**: app settings → **Basic Information** → *App Credentials* → *Signing Secret*.

## 4. Put them in Vercel (project **webhook-service**)

The endpoint lives in the existing Vercel project **webhook-service** (team
"stephens-projects", serves https://pylon-webhook-service.vercel.app). Don't create a new project,
and don't use the similarly named `pylon-webhook-service` project (that one is the old `-sand` URL).

Either in the dashboard: Vercel → webhook-service → **Settings → Environment Variables**
(Production), or from Terminal (each command prompts for the value without showing it):

    cd ~/webhook-service
    vercel env add SLACK_STUDIO_BOT_TOKEN production
    vercel env add SLACK_STUDIO_SIGNING_SECRET production

| Name | Value |
|---|---|
| `SLACK_STUDIO_BOT_TOKEN` | the `xoxb-…` bot token |
| `SLACK_STUDIO_SIGNING_SECRET` | the signing secret |

## 5. Put the bot token in the Studio `.env`

On the Mac that runs the weekly check, add this line to `~/Documents/hadrius-studio/.env`:

    SLACK_STUDIO_BOT_TOKEN=xoxb-…

Then restart the bridge (Studio panel → Update, or `launchctl kickstart -k gui/$(id -u)/com.kbstudio.aibridge`).

## 6. Deploy the service

The new endpoints (`/api/studio-drift`, `/api/studio-drift-slack`) go live with the next
production deploy of the **webhook-service** Vercel project (`vercel --prod` from
`~/webhook-service`, or a push if that project is git-connected). They're not deployed yet — that
happens after review. No new database setup is needed: the `studio_drift_jobs` table is created
on the first request (uses the existing `DATABASE_URL`; auth uses the existing `STUDIO_SHARED_SECRET`).

Check after deploying (Slack doesn't "verify" interactivity URLs, so test them directly):

- `curl -s -o /dev/null -w '%{http_code}\n' https://pylon-webhook-service.vercel.app/api/studio-drift` → `401` (route live, auth required).
- `curl -s -X POST -w ' %{http_code}\n' https://pylon-webhook-service.vercel.app/api/studio-drift-slack` → `401 {"error":"invalid signature"}`
  (`{"error":"not configured"}` means `SLACK_STUDIO_SIGNING_SECRET` isn't set in Vercel yet).
- In the Studio panel, the bridge's `GET /drift/jobs` stops answering "service isn't deployed yet".

Optional: `DRIFT_JOBS_POLL=1` in the Studio `.env` makes the bridge log approved jobs every 10 minutes
(it executes nothing yet).

## 7. Tell Hermes when steps 1–5 are done

A test post (one synthetic "routing check — do not act" job) will confirm the message, the
buttons and the decision write-back before any real video is flagged.
