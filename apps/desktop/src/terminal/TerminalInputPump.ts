export interface TerminalInputPumpOptions {
  write: (data: string) => Promise<void>;
  onError: (error: unknown) => void;
  maxPendingBytes?: number;
  maxChunkBytes?: number;
}

interface PendingInput {
  data: string;
  bytes: number;
}

const DEFAULT_MAX_PENDING_BYTES = 1024 * 1024;
const DEFAULT_MAX_CHUNK_BYTES = 16 * 1024;

/** Serializes terminal writes while bounding memory used by fast input producers. */
export class TerminalInputPump {
  private readonly write: TerminalInputPumpOptions["write"];
  private readonly onError: TerminalInputPumpOptions["onError"];
  private readonly maxPendingBytes: number;
  private readonly maxChunkBytes: number;
  private readonly encoder = new TextEncoder();
  private queue: PendingInput[] = [];
  private pendingBytes = 0;
  private draining = false;
  private disposed = false;

  constructor(options: TerminalInputPumpOptions) {
    this.write = options.write;
    this.onError = options.onError;
    this.maxPendingBytes = options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;
    this.maxChunkBytes = options.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES;
  }

  enqueue(data: string) {
    if (this.disposed || data.length === 0) return;

    const bytes = this.encoder.encode(data).byteLength;
    if (bytes > this.maxPendingBytes || this.pendingBytes + bytes > this.maxPendingBytes) {
      this.onError(new Error("终端输入队列繁忙，请稍后重试"));
      return;
    }

    for (const chunk of splitUtf8(data, this.encoder, this.maxChunkBytes)) {
      this.queue.push({ data: chunk, bytes: this.encoder.encode(chunk).byteLength });
    }
    this.pendingBytes += bytes;
    void this.drain();
  }

  dispose() {
    this.disposed = true;
    this.queue = [];
    this.pendingBytes = 0;
  }

  private async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.disposed && this.queue.length > 0) {
        const item = this.queue[0];
        try {
          await this.write(item.data);
        } catch (error) {
          this.queue = [];
          this.pendingBytes = 0;
          if (!this.disposed) this.onError(error);
          return;
        }
        this.queue.shift();
        this.pendingBytes -= item.bytes;
      }
    } finally {
      this.draining = false;
    }
  }
}

function splitUtf8(data: string, encoder: TextEncoder, maximumBytes: number) {
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const symbol of data) {
    const symbolBytes = encoder.encode(symbol).byteLength;
    if (current && currentBytes + symbolBytes > maximumBytes) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += symbol;
    currentBytes += symbolBytes;
  }
  if (current) chunks.push(current);
  return chunks;
}
