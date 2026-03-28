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

/** @deprecated Use IRIS_FILE_EXPORT_TOOL_INSTRUCTION */
export const IRIS_XLSX_TOOL_INSTRUCTION = `Tools: You can call generate_xlsx_from_screen_chart when the user wants an Excel (.xlsx) or spreadsheet built from what is on their shared screen (charts, figures, tables). Use the latest shared screen frame; you cannot invent numbers—call the tool so the app extracts data and builds the file. After the tool returns, tell them briefly that the file is ready and they can download it from the conversation panel.`;

export const IRIS_FILE_EXPORT_TOOL_INSTRUCTION = `Screen file tools (use the latest shared screen frame; do not invent file contents):
• generate_xlsx_from_screen_chart — Excel (.xlsx) when they want a spreadsheet from charts, figures, or tables.
• generate_txt_from_screen — plain text (.txt) when they want notes, a transcript of visible text, a list, summary, or any non-Excel text file.
After a tool succeeds, say briefly that the file is ready and they can download it from the conversation panel.`;
