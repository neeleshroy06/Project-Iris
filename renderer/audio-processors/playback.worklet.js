/**
 * Queues Float32 PCM for playback (24 kHz).
 */
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;

    this.port.onmessage = (event) => {
      if (event.data === 'interrupt') {
        this.queue = [];
        this.offset = 0;
      } else if (event.data instanceof Float32Array) {
        this.queue.push(event.data);
      }
    };
  }

  process(inputs, outputs) {
    const out = outputs[0][0];
    let i = 0;

    while (i < out.length && this.queue.length > 0) {
      const cur = this.queue[0];
      if (!cur || cur.length === 0) {
        this.queue.shift();
        this.offset = 0;
        continue;
      }
      const need = out.length - i;
      const left = cur.length - this.offset;
      const n = Math.min(need, left);
      for (let k = 0; k < n; k++) {
        out[i++] = cur[this.offset++];
      }
      if (this.offset >= cur.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }

    while (i < out.length) out[i++] = 0;
    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);
