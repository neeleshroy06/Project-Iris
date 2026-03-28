/**
 * Live API function declarations (downloadable files from shared screen).
 * @see https://ai.google.dev/gemini-api/docs/live-tools
 */

export const SPREADSHEET_FUNCTION_DECLARATION = {
  name: 'generate_xlsx_from_screen_chart',
  description:
    'Build a downloadable Microsoft Excel .xlsx file from data visible on the user\'s shared screen (for example a pie chart, bar chart, or table). Call this when the user asks to export, download, or create a spreadsheet or Excel file from what they are showing. Do not claim the file exists until after this tool succeeds.',
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Optional short title for the sheet or file (e.g. "Q3 sales").',
      },
    },
  },
};

export const TEXT_FILE_FUNCTION_DECLARATION = {
  name: 'generate_txt_from_screen',
  description:
    'Build a plain UTF-8 .txt file from what is visible on the shared screen—e.g. copy visible paragraphs, lists, notes, meeting text, code blocks, or a concise summary the user asked for. Call when they want a text file, .txt download, or "save this as a text file", and not specifically Excel.',
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Optional short title or topic for the file name (e.g. "meeting notes").',
      },
    },
  },
};

export const MAPS_LINK_FUNCTION_DECLARATION = {
  name: 'get_google_maps_link_from_screen',
  description:
    "Build an openable Google Maps URL from what is visible on the shared screen: map pins, listings, addresses, business names, or the area inside a focus region. Call when the user asks for a Maps link, directions link, or 'open this in Google Maps'. Use the latest screen frame. Pass userHint with what they mean (e.g. 'the pin', 'region 2', 'the restaurant title') so vision can disambiguate.",
  parameters: {
    type: 'object',
    properties: {
      userHint: {
        type: 'string',
        description:
          'Short phrase for what to locate—e.g. spoken focus on "that café", "the selected pin", "region 1". Empty if only one clear place.',
      },
    },
  },
};

export const CALENDAR_FUNCTION_DECLARATION = {
  name: 'create_google_calendar_event',
  description:
    "Create an event on the user's Google Calendar when they ask to schedule or add a meeting. If you need their Google email, ask them to type it in the text box at the bottom of the Conversation panel and press Enter—it is sent to you as Live text (they do not need to spell it aloud). You may omit googleAccountEmail if they already typed it there in this session. The browser may open for Google sign-in; they must use the SAME account as that email. Use meeting details from the screen/focus regions when relevant. Start and end must be ISO 8601 (e.g. 2026-03-28T15:00:00). Include timeZone (IANA) when known.",
  parameters: {
    type: 'object',
    properties: {
      googleAccountEmail: {
        type: 'string',
        description:
          'Google / Gmail for this action if the user said it or you can take it from their typed line in chat. Do not guess.',
      },
      summary: { type: 'string', description: 'Event title.' },
      start: {
        type: 'string',
        description: 'Start date/time in ISO 8601 (local intent; include offset or use with timeZone).',
      },
      end: {
        type: 'string',
        description: 'End date/time in ISO 8601.',
      },
      timeZone: {
        type: 'string',
        description: 'IANA timezone (e.g. Europe/Berlin). Optional if times include offset.',
      },
      description: {
        type: 'string',
        description: 'Optional notes: location, attendees, dial-in, or visible details.',
      },
    },
    required: ['summary', 'start', 'end'],
  },
};

/** @deprecated Use IRIS_FILE_EXPORT_TOOL_INSTRUCTION */
export const IRIS_XLSX_TOOL_INSTRUCTION = `Tools: You can call generate_xlsx_from_screen_chart when the user wants an Excel (.xlsx) or spreadsheet built from what is on their shared screen (charts, figures, tables). Use the latest shared screen frame; you cannot invent numbers—call the tool so the app extracts data and builds the file. After the tool returns, tell them briefly that the file is ready and they can download it from the conversation panel.`;

export const IRIS_FILE_EXPORT_TOOL_INSTRUCTION = `Screen file tools (use the latest shared screen frame; do not invent file contents):
• generate_xlsx_from_screen_chart — Excel (.xlsx) when they want a spreadsheet from charts, figures, or tables.
• generate_txt_from_screen — plain text (.txt) when they want notes, a transcript of visible text, a list, summary, or any non-Excel text file.
• create_google_calendar_event — For Google email: user can type in the Conversation panel’s bottom text box and press Enter (no need to spell aloud). ISO 8601 for start/end. Browser sign-in must match that email.
• get_google_maps_link_from_screen — opens a Google Maps search or coordinate link from visible map/listing/address; pass userHint when the user points at a specific place or focus region.
After file tools succeed, say briefly that the file is ready and they can download it from the conversation panel. After a calendar event is created, confirm title and time. After a Maps link tool succeeds, say they can tap the link in the transcript.`;
