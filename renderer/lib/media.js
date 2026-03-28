/**
 * Mic → 16 kHz PCM (via AudioWorklet), screen → JPEG frames, playback 24 kHz PCM.
 */

export class MicStreamer {
  constructor(pushBase64Pcm) {
    this._push = pushBase64Pcm;
    this._ctx = null;
    this._worklet = null;
    this._source = null;
    this._stream = null;
    this._running = false;
  }

  async start() {
    const sampleRate = 16000;
    this._stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    this._ctx = new AudioContext({ sampleRate });
    const workletUrl = new URL('../audio-processors/capture.worklet.js', import.meta.url);
    await this._ctx.audioWorklet.addModule(workletUrl.href);

    this._worklet = new AudioWorkletNode(this._ctx, 'audio-capture-processor');
    this._worklet.port.onmessage = (event) => {
      if (!this._running) return;
      if (event.data?.type === 'audio') {
        const pcm = floatToPcm16LE(event.data.data);
        this._push(bufferToBase64(pcm));
      }
    };

    this._source = this._ctx.createMediaStreamSource(this._stream);
    this._source.connect(this._worklet);
    this._running = true;
  }

  stop() {
    this._running = false;
    try {
      this._source?.disconnect();
    } catch {
      /* ignore */
    }
    this._source = null;
    try {
      this._worklet?.disconnect();
      this._worklet?.port?.close();
    } catch {
      /* ignore */
    }
    this._worklet = null;
    this._stream?.getTracks().forEach((t) => t.stop());
    this._stream = null;
    return this._ctx?.close();
  }
}

/** Standard browser / Chromium picker (works on many setups). */
export async function createDisplayMediaStream() {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: false,
  });
  assertNotWebcamTrack(stream.getVideoTracks()[0], 'display capture');
  return stream;
}

/**
 * Electron desktop capture via source id from desktopCapturer.
 * IMPORTANT: `chromeMediaSource` / `chromeMediaSourceId` must live under `mandatory`.
 * If they are placed on `video` directly, Chromium often ignores them and opens the default webcam instead.
 */
export async function createElectronDesktopStream(sourceId) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        minWidth: 16,
        minHeight: 16,
        maxWidth: 8192,
        maxHeight: 8192,
      },
    },
  });
  assertNotWebcamTrack(stream.getVideoTracks()[0], 'desktop capturer');
  return stream;
}

/**
 * Webcam labels after a failed desktop constraint are a common Electron footgun.
 */
function assertNotWebcamTrack(track, context) {
  if (!track) return;
  const label = (track.label || '').toLowerCase();
  const looksLikeWebcam =
    /camera|webcam|facetime|truevision|hp hd|obs virtual|virtualcam|usb video/i.test(
      label
    );
  if (looksLikeWebcam) {
    track.stop();
    throw new Error(
      `Got a webcam (${track.label}) while expecting ${context}. Pick a screen thumbnail, not a camera device.`
    );
  }
}

export class ScreenCapture {
  constructor(pushJpegBase64, options = {}) {
    this._push = pushJpegBase64;
    this._fps = options.fps ?? 1;
    this._maxWidth = options.maxWidth ?? 1280;
    this._quality = options.quality ?? 0.72;
    /** @type {() => Array<{ nx: number, ny: number, nw: number, nh: number, label?: number }>} */
    this._getFocusRegions = typeof options.getFocusRegions === 'function' ? options.getFocusRegions : () => [];
    this._timer = null;
    this._stream = null;
    this._video = null;
    this._canvas = null;
    this._ctx2d = null;
    this._captureW = 0;
    this._captureH = 0;
    this._running = false;
  }

  /**
   * @param {MediaStream|null} existingStream  If provided (e.g. Electron desktop capture), skips getDisplayMedia.
   */
  async start(existingStream = null) {
    if (existingStream) {
      this._stream = existingStream;
    } else {
      // Avoid displaySurface / strict constraints — they often break getDisplayMedia on Windows.
      this._stream = await createDisplayMediaStream();
    }

    const track = this._stream.getVideoTracks()[0];
    assertNotWebcamTrack(track, 'screen share');
    track.onended = () => this.stop();

    this._video = document.createElement('video');
    this._video.srcObject = this._stream;
    this._video.muted = true;
    this._video.playsInline = true;
    await this._video.play();

    await new Promise((r) => {
      if (this._video.readyState >= 2) r();
      else this._video.onloadeddata = () => r();
    });

    const vw = this._video.videoWidth;
    const vh = this._video.videoHeight;
    let w = vw;
    let h = vh;
    if (w > this._maxWidth) {
      h = Math.round((this._maxWidth / w) * h);
      w = this._maxWidth;
    }

    this._canvas = document.createElement('canvas');
    this._canvas.width = w;
    this._canvas.height = h;
    this._ctx2d = this._canvas.getContext('2d');
    this._captureW = w;
    this._captureH = h;

    const tick = () => {
      if (!this._running || !this._ctx2d || !this._video) return;
      const ctx = this._ctx2d;
      const cw = this._captureW;
      const ch = this._captureH;
      ctx.drawImage(this._video, 0, 0, cw, ch);
      const regions = this._getFocusRegions();
      if (regions?.length) {
        const lw = Math.max(2, Math.round(cw / 400));
        ctx.save();
        ctx.strokeStyle = 'rgba(255, 48, 48, 0.92)';
        ctx.lineWidth = lw;
        ctx.setLineDash([]);
        ctx.font = `600 ${Math.max(12, Math.round(cw / 70))}px system-ui, sans-serif`;
        ctx.fillStyle = 'rgba(255, 48, 48, 0.95)';
        regions.forEach((r) => {
          const x = r.nx * cw;
          const y = r.ny * ch;
          const rw = r.nw * cw;
          const rh = r.nh * ch;
          ctx.strokeRect(x, y, rw, rh);
          const num = r.label != null ? r.label : 1;
          ctx.fillText(String(num), x + lw + 2, y + lw + Math.max(12, Math.round(ch / 55)));
        });
        ctx.restore();
      }
      this._canvas.toBlob(
        (blob) => {
          if (!blob || !this._running) return;
          const reader = new FileReader();
          reader.onloadend = () => {
            const dataUrl = reader.result;
            const b64 = dataUrl.split(',')[1];
            if (b64) this._push(b64);
          };
          reader.readAsDataURL(blob);
        },
        'image/jpeg',
        this._quality
      );
    };

    this._running = true;
    const interval = Math.max(333, Math.round(1000 / this._fps));
    this._timer = setInterval(tick, interval);
    tick();

    return { width: w, height: h, stream: this._stream };
  }

  stop() {
    this._running = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._stream?.getTracks().forEach((t) => t.stop());
    this._stream = null;
    if (this._video) {
      this._video.srcObject = null;
      this._video = null;
    }
    this._canvas = null;
    this._ctx2d = null;
  }

  attachPreview(videoEl) {
    if (this._stream && videoEl) {
      videoEl.srcObject = this._stream;
      videoEl.play().catch(() => {});
    }
  }
}

export class PcmPlayer {
  constructor() {
    this._ctx = null;
    this._node = null;
    this._gain = null;
    this._ready = null;
  }

  async _ensure() {
    if (this._node) return;
    this._ctx = new AudioContext({ sampleRate: 24000 });
    const url = new URL('../audio-processors/playback.worklet.js', import.meta.url);
    await this._ctx.audioWorklet.addModule(url.href);
    this._node = new AudioWorkletNode(this._ctx, 'pcm-processor');
    this._gain = this._ctx.createGain();
    this._gain.gain.value = 1;
    this._node.connect(this._gain);
    this._gain.connect(this._ctx.destination);
  }

  async playBase64Pcm16Le(base64) {
    await this._ensure();
    if (this._ctx.state === 'suspended') await this._ctx.resume();

    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const int16 = new Int16Array(bytes.buffer);
    const f32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      f32[i] = int16[i] / 32768;
    }
    this._node.port.postMessage(f32);
  }

  interrupt() {
    if (this._node) this._node.port.postMessage('interrupt');
  }

  async destroy() {
    this.interrupt();
    if (this._ctx) {
      await this._ctx.close();
      this._ctx = null;
    }
    this._node = null;
    this._gain = null;
  }
}

function floatToPcm16LE(float32Array) {
  const out = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out.buffer;
}

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
