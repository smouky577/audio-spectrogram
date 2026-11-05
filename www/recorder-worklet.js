// Collects mono samples and posts them to the main thread in blocks.
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(8192);
    this.len = 0;
    this.port.onmessage = () => this.flush();
  }

  flush() {
    if (!this.len) return;
    this.port.postMessage(this.buf.slice(0, this.len));
    this.len = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.len++] = ch[i];
        if (this.len === this.buf.length) this.flush();
      }
    }
    return true;
  }
}

registerProcessor('recorder', RecorderProcessor);
