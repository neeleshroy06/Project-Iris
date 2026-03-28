/**
 * Gemini Live API (WebSocket) — v1beta + API key.
 * @see https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket
 */

export const MODEL_LIVE_FLASH = 'gemini-3.1-flash-live-preview';

const WS_PATH =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

function parseServerMessage(raw) {
  const out = {
    setupComplete: false,
    audioChunks: [],
    inputTranscription: null,
    outputTranscription: null,
    interrupted: false,
    turnComplete: false,
    textParts: [],
    toolCall: null,
    error: null,
  };

  let data;
  try {
    data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    out.error = 'Invalid JSON from server';
    return out;
  }

  if (data.error) {
    out.error = JSON.stringify(data.error);
    return out;
  }

  if (data.setupComplete) {
    out.setupComplete = true;
    return out;
  }

  if (data.toolCall) {
    out.toolCall = data.toolCall;
    return out;
  }

  const sc = data.serverContent;
  if (!sc) return out;

  if (sc.interrupted) out.interrupted = true;

  if (sc.turnComplete) out.turnComplete = true;

  const parts = sc.modelTurn?.parts;
  if (Array.isArray(parts)) {
    for (const part of parts) {
      if (part.inlineData?.data) {
        out.audioChunks.push(part.inlineData.data);
      }
      if (part.text) {
        out.textParts.push(part.text);
      }
    }
  }

  if (sc.inputTranscription) {
    out.inputTranscription = {
      text: sc.inputTranscription.text || '',
      finished: !!sc.inputTranscription.finished,
    };
  }

  if (sc.outputTranscription) {
    out.outputTranscription = {
      text: sc.outputTranscription.text || '',
      finished: !!sc.outputTranscription.finished,
    };
  }

  return out;
}

export class GeminiLiveSession {
  constructor(apiKey, options = {}) {
    this._apiKey = apiKey;
    this._model = options.model || MODEL_LIVE_FLASH;
    this._voiceName = options.voiceName || 'Kore';
    this._temperature = options.temperature ?? 0.9;
    this._systemInstruction =
      options.systemInstruction ||
      `You are Iris, a concise, friendly desktop copilot. The user shares their screen as periodic still images (about one per second) and speaks aloud. They may draw numbered focus regions on their desktop; you will also receive text messages that give normalized bounding boxes (x,y,w,h from 0 to 1, top-left origin) for each region relative to the shared frame or—if noted—relative to the full virtual desktop. When they say "region 1", use that grounding text together with the latest image. Keep spoken replies short and natural; avoid markdown walls unless asked.`;

    this._ws = null;
    this.connected = false;

    this.onSetupComplete = () => {};
    this.onAudioBase64 = () => {};
    this.onInputTranscription = () => {};
    this.onOutputTranscription = () => {};
    this.onInterrupted = () => {};
    this.onTurnComplete = () => {};
    this.onError = () => {};
    this.onClose = () => {};
  }

  _buildSetupMessage() {
    return {
      setup: {
        model: `models/${this._model}`,
        generationConfig: {
          responseModalities: ['AUDIO'],
          temperature: this._temperature,
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: this._voiceName,
              },
            },
          },
        },
        systemInstruction: {
          parts: [{ text: this._systemInstruction }],
        },
        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: false,
            silenceDurationMs: 2200,
            prefixPaddingMs: 480,
          },
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
    };
  }

  connect() {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) return;

    const url = `${WS_PATH}?key=${encodeURIComponent(this._apiKey)}`;
    this._ws = new WebSocket(url);

    this._ws.onopen = () => {
      this.connected = true;
      this._ws.send(JSON.stringify(this._buildSetupMessage()));
    };

    this._ws.onclose = () => {
      this.connected = false;
      this.onClose();
    };

    this._ws.onerror = () => {
      this.connected = false;
      this.onError(new Error('WebSocket error'));
    };

    this._ws.onmessage = async (event) => {
      let text;
      if (event.data instanceof Blob) {
        text = await event.data.text();
      } else if (event.data instanceof ArrayBuffer) {
        text = new TextDecoder().decode(event.data);
      } else {
        text = event.data;
      }

      const parsed = parseServerMessage(text);

      if (parsed.error) {
        this.onError(new Error(parsed.error));
        return;
      }

      if (parsed.setupComplete) {
        this.onSetupComplete();
        return;
      }

      if (parsed.toolCall) {
        return;
      }

      for (const chunk of parsed.audioChunks) {
        this.onAudioBase64(chunk);
      }

      if (parsed.inputTranscription) {
        this.onInputTranscription(parsed.inputTranscription);
      }

      if (parsed.outputTranscription) {
        this.onOutputTranscription(parsed.outputTranscription);
      }

      if (parsed.interrupted) {
        this.onInterrupted();
      }

      if (parsed.turnComplete) {
        this.onTurnComplete();
      }
    };
  }

  disconnect() {
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    this.connected = false;
  }

  sendAudioPcm16Base64(base64) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    const msg = {
      realtimeInput: {
        audio: {
          data: base64,
          mimeType: 'audio/pcm;rate=16000',
        },
      },
    };
    this._ws.send(JSON.stringify(msg));
  }

  sendScreenJpegBase64(base64) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    const msg = {
      realtimeInput: {
        video: {
          data: base64,
          mimeType: 'image/jpeg',
        },
      },
    };
    this._ws.send(JSON.stringify(msg));
  }

  sendText(text) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    this._ws.send(JSON.stringify({ realtimeInput: { text } }));
  }
}
