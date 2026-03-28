/**
 * Buffers float samples at 16 kHz; emits ~32 ms chunks for Gemini Live.
 */
class AudioCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 512;
    this.buffer = new Float32Array(this.bufferSize);
    this.bufferIndex = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const ch0 = input[0];
    for (let i = 0; i < ch0.length; i++) {
      this.buffer[this.bufferIndex++] = ch0[i];
      if (this.bufferIndex >= this.bufferSize) {
        this.port.postMessage({ type: 'audio', data: this.buffer.slice() });
        this.bufferIndex = 0;
      }
    }
    return true;
  }
}

registerProcessor('audio-capture-processor', AudioCaptureProcessor);
