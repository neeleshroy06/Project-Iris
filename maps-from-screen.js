/**
 * Gemini Flash (REST) reads the latest shared screen JPEG and returns a Google Maps URL.
 * Uses the same model pool as chart export unless GEMINI_MAPS_EXTRACT_MODEL is set.
 */

const MODEL =
  (process.env.GEMINI_MAPS_EXTRACT_MODEL || process.env.GEMINI_CHART_EXTRACT_MODEL || 'gemini-2.5-flash-lite')
    .trim() || 'gemini-2.5-flash-lite';

/**
 * @param {{ query?: string, lat?: number|null, lng?: number|null, label?: string }} parsed
 * @returns {string|null}
 */
function buildGoogleMapsUrl(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const lat = parsed.lat;
  const lng = parsed.lng;
  if (typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng)) {
    return `https://www.google.com/maps?q=${lat},${lng}`;
  }
  const q = typeof parsed.query === 'string' ? parsed.query.trim() : '';
  if (!q) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

/**
 * @param {string} apiKey
 * @param {string} imageBase64
 * @param {string} [userHint]
 * @returns {Promise<{ query: string, lat: number|null, lng: number|null, label: string, mapsUrl: string }>}
 */
async function extractMapsLinkJson(apiKey, imageBase64, userHint) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const prompt = `You help build a Google Maps link from a screenshot. The image may show:
- Google Maps, Apple Maps, OpenStreetMap, or another map with a pin, route, or place card
- A business listing, address block, Yelp/OpenTable, search result with location
- Partial text (street, city, venue name)

The user may be focused on a specific area or place; use their hint to pick ONE best destination.

Return ONLY valid JSON (no markdown), exactly:
{"query":"string — full place name and/or address for Google search, or empty string if using coordinates","lat":null or a number,"lng":null or a number,"label":"short description of what you chose"}

Rules:
- Prefer lat/lng only if you clearly see coordinates or an obvious map center pin with inferable position; otherwise use query with a rich search string (e.g. "Joe's Coffee 123 Main St Boston").
- If multiple places appear, choose the one matching the user hint; if the hint is empty, choose the most prominent single place.
- If nothing location-like is visible, return {"query":"","lat":null,"lng":null,"label":"no_place_found"}.

${userHint ? `User hint (what they care about on screen): "${userHint.replace(/"/g, "'")}"` : 'No extra user hint; pick the clearest single place.'}`;

  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            inline_data: {
              mime_type: 'image/jpeg',
              data: imageBase64,
            },
          },
          { text: prompt },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.2,
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`Gemini (${MODEL}): ${res.status} ${raw.slice(0, 400)}`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON from Gemini API');
  }

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text || typeof text !== 'string') {
    throw new Error('No extraction text from Gemini');
  }

  let parsed;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('Could not parse maps JSON');
    parsed = JSON.parse(m[0]);
  }

  const query = typeof parsed.query === 'string' ? parsed.query.trim() : '';
  let lat = parsed.lat != null ? Number(parsed.lat) : null;
  let lng = parsed.lng != null ? Number(parsed.lng) : null;
  if (lat != null && !Number.isFinite(lat)) lat = null;
  if (lng != null && !Number.isFinite(lng)) lng = null;

  const label =
    typeof parsed.label === 'string' && parsed.label.trim()
      ? parsed.label.trim()
      : query || 'Maps';

  const normalized = {
    query,
    lat,
    lng,
    label,
  };

  const mapsUrl = buildGoogleMapsUrl(normalized);
  if (!mapsUrl) {
    if (label === 'no_place_found' || (!query && lat == null)) {
      throw new Error('No place or address could be read from the screen. Share a map or listing and try again.');
    }
    throw new Error('Could not build a Maps link from the model output.');
  }

  return { ...normalized, mapsUrl };
}

module.exports = {
  extractMapsLinkJson,
  buildGoogleMapsUrl,
  MODEL,
};
