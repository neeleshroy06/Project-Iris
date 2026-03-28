/**
 * Google Calendar OAuth (desktop loopback) + event creation.
 * Tokens live in app userData (encrypted with safeStorage when available).
 */

const http = require('http');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const { app, safeStorage, shell } = require('electron');
const { google } = require('googleapis');

const DEFAULT_REDIRECT_PORT = 45231;
const DEFAULT_REDIRECT_PATH = '/oauth2callback';

const TOKEN_PLAIN = 'google-calendar-tokens.json';
const TOKEN_ENC = 'google-calendar-tokens.enc';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/userinfo.email',
];

/** @returns {{ port: number, pathname: string, href: string }} */
function getRedirectConfig() {
  const raw = (process.env.GOOGLE_OAUTH_REDIRECT_URI || '').trim();
  if (raw) {
    try {
      const u = new URL(raw);
      if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') {
        console.warn('[google-calendar] Redirect URI should use 127.0.0.1 for desktop OAuth.');
      }
      const port = u.port ? parseInt(u.port, 10) : DEFAULT_REDIRECT_PORT;
      const pathname = u.pathname && u.pathname !== '/' ? u.pathname : DEFAULT_REDIRECT_PATH;
      return { port, pathname, href: u.href.split('#')[0] };
    } catch {
      /* fall through */
    }
  }
  const href = `http://127.0.0.1:${DEFAULT_REDIRECT_PORT}${DEFAULT_REDIRECT_PATH}`;
  return {
    port: DEFAULT_REDIRECT_PORT,
    pathname: DEFAULT_REDIRECT_PATH,
    href,
  };
}

function redirectUriString() {
  return getRedirectConfig().href;
}

function tokenPathPlain() {
  return path.join(app.getPath('userData'), TOKEN_PLAIN);
}

function tokenPathEnc() {
  return path.join(app.getPath('userData'), TOKEN_ENC);
}

function loadTokens() {
  const encPath = tokenPathEnc();
  if (fs.existsSync(encPath) && safeStorage.isEncryptionAvailable()) {
    try {
      const buf = fs.readFileSync(encPath);
      const json = safeStorage.decryptString(buf);
      return JSON.parse(json);
    } catch {
      return null;
    }
  }
  const plainPath = tokenPathPlain();
  if (fs.existsSync(plainPath)) {
    try {
      return JSON.parse(fs.readFileSync(plainPath, 'utf8'));
    } catch {
      return null;
    }
  }
  return null;
}

function saveTokens(tokens) {
  const json = JSON.stringify(tokens);
  if (safeStorage.isEncryptionAvailable()) {
    const buf = safeStorage.encryptString(json);
    fs.writeFileSync(tokenPathEnc(), buf);
    try {
      fs.unlinkSync(tokenPathPlain());
    } catch {
      /* ignore */
    }
  } else {
    fs.writeFileSync(tokenPathPlain(), json, 'utf8');
    try {
      fs.unlinkSync(tokenPathEnc());
    } catch {
      /* ignore */
    }
  }
}

function clearTokens() {
  try {
    fs.unlinkSync(tokenPathEnc());
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(tokenPathPlain());
  } catch {
    /* ignore */
  }
}

function getOAuthCredentials() {
  const clientId = (process.env.GOOGLE_OAUTH_CLIENT_ID || '').trim();
  const clientSecret = (process.env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim();
  return { clientId, clientSecret };
}

function isOAuthConfigured() {
  const { clientId, clientSecret } = getOAuthCredentials();
  return !!(clientId && clientSecret);
}

function createOAuth2Client() {
  const { clientId, clientSecret } = getOAuthCredentials();
  if (!clientId || !clientSecret) {
    throw new Error('Missing GOOGLE_OAUTH_CLIENT_ID or GOOGLE_OAUTH_CLIENT_SECRET');
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirectUriString());
}

async function getAuthenticatedClient() {
  const tokens = loadTokens();
  if (!tokens) return null;
  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials(tokens);
  return oauth2Client;
}

/**
 * Opens system browser for Google consent; local server catches redirect.
 * @returns {Promise<{ ok: boolean }>}
 */
function startAuthFlow() {
  if (!isOAuthConfigured()) {
    return Promise.reject(
      new Error('Add GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET to .env')
    );
  }

  const oauth2Client = createOAuth2Client();
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });

  const { port, pathname } = getRedirectConfig();
  const pathForServer = pathname.startsWith('/') ? pathname : `/${pathname}`;

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      fn();
    };

    const timeoutId = setTimeout(() => {
      try {
        server.close();
      } catch {
        /* ignore */
      }
      done(() => reject(new Error('Sign-in timed out. Close the browser tab and try again.')));
    }, 300_000);

    const server = http.createServer(async (req, res) => {
      try {
        const u = new URL(req.url, `http://127.0.0.1:${port}`);
        if (u.pathname !== pathForServer) {
          res.writeHead(404);
          res.end();
          return;
        }

        const code = u.searchParams.get('code');
        const errParam = u.searchParams.get('error');

        if (errParam) {
          const errDescRaw = u.searchParams.get('error_description') || '';
          let errDesc = errDescRaw;
          try {
            errDesc = decodeURIComponent(errDescRaw.replace(/\+/g, ' '));
          } catch {
            /* ignore */
          }
          let msg = `Google OAuth error: ${errParam}`;
          if (errDesc) msg += ` — ${errDesc}`;
          if (errParam === 'access_denied') {
            msg +=
              ' FIX (Testing mode): Google Cloud Console → APIs & Services → OAuth consent screen → “Test users” → Add the exact Gmail you use to sign in → Save. Wait 1–2 minutes. While Publishing status is Testing, only those emails can sign in (not an API key mistake).';
          }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          const esc = (s) =>
            String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          res.end(
            `<!DOCTYPE html><html><body><p>Authorization did not complete.</p><pre style="white-space:pre-wrap;font:inherit">${esc(
              msg
            )}</pre><p>You can close this window.</p></body></html>`
          );
          try {
            server.close();
          } catch {
            /* ignore */
          }
          done(() => reject(new Error(msg)));
          return;
        }

        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Missing code');
          try {
            server.close();
          } catch {
            /* ignore */
          }
          done(() => reject(new Error('No authorization code')));
          return;
        }

        let tokens;
        try {
          const tokenRes = await oauth2Client.getToken(code);
          tokens = tokenRes.tokens;
        } catch (e) {
          const msg = e?.message || String(e);
          throw new Error(
            `Could not exchange authorization code for tokens: ${msg}. Check that the redirect URI in Google Cloud matches this app exactly (including port and path).`
          );
        }
        if (!tokens || !tokens.access_token) {
          throw new Error('Google returned no tokens after sign-in. Try again or revoke Iris access in your Google account and retry.');
        }
        saveTokens(tokens);
        oauth2Client.setCredentials(tokens);

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          '<!DOCTYPE html><html><body><p>Google Calendar connected. You can close this window and return to Iris.</p></body></html>'
        );
        try {
          server.close();
        } catch {
          /* ignore */
        }
        done(() => resolve({ ok: true }));
      } catch (e) {
        try {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end(e?.message || String(e));
        } catch {
          /* ignore */
        }
        try {
          server.close();
        } catch {
          /* ignore */
        }
        done(() => reject(e));
      }
    });

    server.on('error', (err) => {
      done(() =>
        reject(
          err.code === 'EADDRINUSE'
            ? new Error(
                `Port ${port} is in use. Set GOOGLE_OAUTH_REDIRECT_URI to another http://127.0.0.1:PORT/oauth2callback and add it in Google Cloud Console.`
              )
            : err
        )
      );
    });

    server.listen(port, '127.0.0.1', () => {
      shell.openExternal(authUrl);
    });
  });
}

function getCalendarStatus() {
  return {
    configured: isOAuthConfigured(),
    connected: !!loadTokens(),
    redirectUri: redirectUriString(),
  };
}

/**
 * @param {{ summary: string, start: string, end: string, googleAccountEmail: string, timeZone?: string, description?: string }} payload
 * ISO 8601 dateTime for start/end recommended. googleAccountEmail must match the signed-in Google account.
 */
async function createCalendarEvent(payload) {
  const auth = await getAuthenticatedClient();
  if (!auth) {
    return {
      success: false,
      userMessage:
        'Google sign-in did not complete. The browser should open when you create a calendar event; finish signing in there, then try again.',
    };
  }

  const requestedEmail =
    typeof payload.googleAccountEmail === 'string' ? payload.googleAccountEmail.trim().toLowerCase() : '';
  if (!requestedEmail || !requestedEmail.includes('@')) {
    return {
      success: false,
      userMessage:
        'Ask the user which Google account email to use for Calendar, then call this tool again with googleAccountEmail set to that address.',
    };
  }

  let signedEmail = '';
  try {
    const oauth2Api = google.oauth2({ version: 'v2', auth });
    const { data: u } = await oauth2Api.userinfo.get();
    signedEmail = (u.email || '').toLowerCase().trim();
  } catch {
    return {
      success: false,
      userMessage:
        'Could not read your Google account email. Sign out and complete browser sign-in again (Calendar scopes may need updating).',
    };
  }

  if (!signedEmail) {
    return {
      success: false,
      userMessage: 'Google did not return an email for this account. Try signing in with a full Google account.',
    };
  }

  if (signedEmail !== requestedEmail) {
    return {
      success: false,
      userMessage: `The Google account you signed in with (${signedEmail}) does not match the email the user gave (${requestedEmail}). Ask them to confirm their Google email, or sign in with the matching account in the browser.`,
    };
  }

  const summary = typeof payload.summary === 'string' ? payload.summary.trim() : '';
  const start = typeof payload.start === 'string' ? payload.start.trim() : '';
  const end = typeof payload.end === 'string' ? payload.end.trim() : '';
  if (!summary || !start || !end) {
    return {
      success: false,
      userMessage: 'Missing title, start, or end time for the event.',
    };
  }

  const tz =
    typeof payload.timeZone === 'string' && payload.timeZone.trim()
      ? payload.timeZone.trim()
      : Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  const calendar = google.calendar({ version: 'v3', auth });
  const requestBody = {
    summary,
    start: { dateTime: start, timeZone: tz },
    end: { dateTime: end, timeZone: tz },
  };
  let desc = typeof payload.description === 'string' ? payload.description.trim() : '';
  const accountLine = `Google account: ${requestedEmail}`;
  desc = desc ? `${desc}\n\n${accountLine}` : accountLine;
  requestBody.description = desc;

  try {
    const { data } = await calendar.events.insert({
      calendarId: 'primary',
      requestBody,
    });
    return {
      success: true,
      summary: data.summary,
      htmlLink: data.htmlLink,
      id: data.id,
    };
  } catch (e) {
    const msg = e?.message || String(e);
    return { success: false, error: msg, userMessage: `Could not create event: ${msg}` };
  }
}

module.exports = {
  getRedirectConfig,
  redirectUriString,
  startAuthFlow,
  getCalendarStatus,
  createCalendarEvent,
  clearTokens,
  isOAuthConfigured,
};
