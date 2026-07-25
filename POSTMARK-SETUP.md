# Postmark — setup notes

Two separate things use Postmark:

## 1. Supabase auth emails (confirmation / password reset)
Configured in the **Supabase dashboard**, not in this repo.
Authentication → Emails → SMTP settings:

| Field         | Value |
|---------------|-------|
| Host          | `smtp.postmarkapp.com` |
| Port          | `587` |
| Username      | **Server API Token** (Postmark → Servers → your server → API Tokens) |
| Password      | **the same Server API Token** |
| Sender email  | `no-reply@personalwings.com` (must be a verified Sender Signature / domain) |
| Sender name   | `Personal Wings` |

Notes:
- Postmark SMTP auth uses the **Server API Token as both username and password** — not your account login.
- The sender must be verified in Postmark first (Sender Signatures).
- New Postmark accounts are approval-pending and can only send to your own domain until approved — test with a `@personalwings.com` address first.

## 2. User-notification blast (`/.netlify/functions/notify` + `/admin.html`)
Reads your user directory (the `profiles` table) and emails everyone via the Postmark API.

Set these **Netlify** env vars (Site settings → Environment variables, all scopes), then redeploy:

| Var | Value |
|-----|-------|
| `ADMIN_KEY` | a long random string you invent — gates the send page |
| `POSTMARK_TOKEN` | your Postmark Server API Token |
| `POSTMARK_FROM` | `no-reply@personalwings.com` (verified sender) |
| `POSTMARK_STREAM` | `broadcast` (bulk mail must use a Broadcast stream) |
| `SUPABASE_URL` | `https://dbkbigxeabzfzoqommtf.supabase.co` |
| `SUPABASE_SERVICE_ROLE` | Supabase **service_role** key (Project Settings → API). Server-only secret — bypasses RLS. Never put this in client code. |

Then open `https://<your-netlify-site>/admin.html`, enter the admin key, write a subject + message, **Send test to me** first, then **Send to all users**.

The message is plain text (blank lines = new paragraphs); a Personal Wings header and an unsubscribe footer are added automatically. Bulk mail goes through Postmark's `broadcast` stream so unsubscribes are handled for you.
