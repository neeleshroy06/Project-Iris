/**
 * Gemini Flash (REST) reads the latest shared screen JPEG for file export:
 * chart/table → .xlsx, or visible/summary text → UTF-8 .txt.
 */

const XLSX = require('xlsx');

/**
 * Chart → JSON extraction uses the Generative Language REST API (not Live).
 * Default: gemini-2.5-flash-lite (vision + structured output; matches typical free-tier “Flash Lite” pools).
 * Override: GEMINI_CHART_EXTRACT_MODEL=gemini-3-flash-preview (or another text-out model you have quota for).
 */
const MODEL =
  (process.env.GEMINI_CHART_EXTRACT_MODEL || 'gemini-2.5-flash-lite').trim() || 'gemini-2.5-flash-lite';

/**
 * @param {string} apiKey
 * @param {string} imageBase64 raw base64 (no data: prefix)
 * @param {string} [hintTitle]
 * @returns {Promise<{ title: string, rows: { label: string, value: number }[] }>}
 */
async function extractChartJson(apiKey, imageBase64, hintTitle) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const prompt = `You are a data extraction assistant. The image may contain a pie chart, donut chart, bar chart, line chart, or a table of numbers.

Extract every labeled segment or row that has a numeric value. Return ONLY valid JSON (no markdown fences), exactly in this shape:
{"title":"short descriptive title or empty string","rows":[{"label":"string","value":number}]}

Rules:
- Use the exact text labels shown in the chart or table.
- If values are percentages, store them as numbers (e.g. 42.5 for 42.5%).
- If you cannot read the image or there is no chart/table data, return {"title":"","rows":[]}.
${hintTitle ? `The user suggested this title if appropriate: "${hintTitle}".` : ''}`;

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
      temperature: 0.15,
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
    if (!m) throw new Error('Could not parse chart JSON');
    parsed = JSON.parse(m[0]);
  }

  const rowsIn = Array.isArray(parsed.rows) ? parsed.rows : [];
  const rows = rowsIn
    .map((r) => ({
      label: r && r.label != null ? String(r.label) : '',
      value: typeof r?.value === 'number' && !Number.isNaN(r.value) ? r.value : Number(r?.value),
    }))
    .filter((r) => r.label && Number.isFinite(r.value));

  const title =
    typeof parsed.title === 'string' && parsed.title.trim()
      ? parsed.title.trim()
      : hintTitle && String(hintTitle).trim()
        ? String(hintTitle).trim()
        : 'Chart data';

  return { title, rows };
}

/**
 * Plain .txt body from screen (REST, same model as chart export).
 * @param {string} apiKey
 * @param {string} imageBase64
 * @param {string} [hintTitle]
 * @returns {Promise<{ title: string, text: string }>}
 */
async function extractTextFileJson(apiKey, imageBase64, hintTitle) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const prompt = `You are creating a plain UTF-8 .txt file from the screen image.

Return ONLY valid JSON (no markdown fences), exactly in this shape:
{"title":"short filename stem or empty string","text":"full body for the .txt file"}

Rules:
- If the user wants an exact copy of visible text, transcribe it faithfully in "text". Use \\n in the JSON string for line breaks.
- If they want a summary, bullet list, cleaned-up notes, or extracted key points, put that in "text".
- If nothing useful is visible, return {"title":"","text":""}.
${hintTitle ? `User hint for title or topic: "${hintTitle}".` : ''}`;

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
    if (!m) throw new Error('Could not parse text-file JSON');
    parsed = JSON.parse(m[0]);
  }

  const bodyText = parsed.text != null ? String(parsed.text) : '';
  if (!bodyText.trim()) {
    throw new Error('No text content could be extracted from the screen.');
  }

  const title =
    typeof parsed.title === 'string' && parsed.title.trim()
      ? parsed.title.trim()
      : hintTitle && String(hintTitle).trim()
        ? String(hintTitle).trim()
        : 'Notes';

  return { title, text: bodyText };
}

/**
 * @param {string} text
 * @returns {Buffer}
 */
function buildTxtBuffer(text) {
  return Buffer.from(text, 'utf8');
}

/**
 * @param {{ label: string, value: number }[]} rows
 * @param {string} sheetTitle
 * @returns {Buffer}
 */
function buildXlsxBuffer(rows, sheetTitle) {
  const wb = XLSX.utils.book_new();
  const aoa = [['Label', 'Value'], ...rows.map((r) => [r.label, r.value])];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const safe = (sheetTitle || 'Data').replace(/[[\]:*?/\\]/g, '_').slice(0, 31) || 'Data';
  XLSX.utils.book_append_sheet(wb, ws, safe);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = {
  extractChartJson,
  buildXlsxBuffer,
  extractTextFileJson,
  buildTxtBuffer,
  MODEL,
};
