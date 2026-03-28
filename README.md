# Iris

Desktop voice + screen assistant powered by **Google Gemini Multimodal Live**. Talk naturally; Iris replies with speech and sees periodic screen captures so answers match what’s on your display.

## Requirements

- **Node.js** (LTS recommended)
- A **Gemini API key** with access to the Live model ([Google AI Studio](https://aistudio.google.com/apikey))
- Microphone and (optional) screen-capture permission when prompted by the OS

## Quick start

```bash
git clone <your-repo-url>
cd Project_Iris
npm install
```

Copy `.env.example` to `.env` and set your key:

```env
GEMINI_API_KEY=your_key_here
```

Run the app:

```bash
npm start
```

On first launch, use **Get started** on the welcome screen, then **Start session** and **Share screen** when you want Iris to use your display.

## What you get

| Area | What it does |
|------|----------------|
| **Live voice** | Bidirectional audio with the Gemini Live WebSocket; transcript in the side panel |
| **Screen share** | Still frames (~1 fps) to the model; in-app preview |
| **Observation** | **Silent** — speaks only when you engage; **Ambient** — brief notes on meaningful screen changes (pick before starting; new session if you change mode) |
| **Focus regions** | Draw regions on screen (when using the shell) so Iris can align with numbered areas |
| **Exports** | Optional spreadsheet or text export from the shared screen (REST + vision) |
| **Maps link** | Ask for a Google Maps link to something on screen (map pin, address, listing); uses Gemini on the latest frame + optional hint for focus |
| **Memory** | Long-term notes from past sessions are stored under the app user data folder and merged into the next session (does not live in this repo) |
| **Google Calendar** | When Iris needs your Google email, type it in the **text box under the conversation** and press **Enter** (sent to Live—no spelling aloud). Browser sign-in must match that account. |
| **Themes** | Dark / light toggle on welcome and main UI |

Optional environment variables are documented in `.env.example` (e.g. models for file export and memory consolidation).

### Google Calendar (optional)

1. In [Google Cloud Console](https://console.cloud.google.com/), enable **Google Calendar API** and create an **OAuth client ID** of type **Desktop app**.
2. On the **OAuth consent screen**, include scopes for **Calendar** and **user email** (Iris requests `calendar.events` and `userinfo.email` so the address you say in chat can match the account you sign into).
3. Under **Authorized redirect URIs**, add exactly: `http://127.0.0.1:45231/oauth2callback` (or your custom `GOOGLE_OAUTH_REDIRECT_URI` + same entry in Console).
4. Put **Client ID** and **Client secret** in `.env` (`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`).
5. In a live session, say you want a calendar event. Iris asks which **Google email** to use—you answer by voice. Then the tool runs; if needed, your **browser** opens once so you can sign in with **that same** Google account.

**Error 403 `access_denied` — “only developer-approved testers” / “has not completed verification”**

This usually means the OAuth app is in **Testing**, and your Google account is **not** on the allowlist yet. It is **not** because the Calendar API or `.env` client ID is wrong.

1. Open [Google Cloud Console](https://console.cloud.google.com/) → select **the same project** as your OAuth client.
2. **APIs & Services** → **OAuth consent screen** (left menu).
3. Scroll to **Test users** (under *Audience* on some layouts).
4. Click **+ ADD USERS** and add **the same Gmail you use when the browser opens** (e.g. the address shown on Google’s error page).
5. Click **Save**. Wait a minute.
6. In Iris, try the calendar flow again (you may need to sign out of Google in the browser or use a private window so Google shows the consent screen again).

**Optional:** If **Publishing status** is **Testing**, only those test users work. To allow any Google user you’d switch to **In production** (Google may ask for app verification for sensitive scopes—fine for personal use to stay on Testing + test users).

**“This app isn’t verified” (different warning):** click **Advanced** → **Go to Iris (unsafe)**. That screen is separate from the “testers” block above.

## Security

- Keep `.env` **local** and **out of version control**. Do not publish a build that embeds your API key for untrusted users; prefer bring-your-own-key or a backend for public distribution.
- **Google OAuth** secrets in `.env` are as sensitive as your API key. Calendar tokens are stored under the app user data path (encrypted when the OS supports Electron `safeStorage`).

## License

MIT
