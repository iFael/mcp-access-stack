export type BrowserLiveFrame = {
  seq: number;
  data: string;
  width: number;
  height: number;
  capturedAt: number;
};

export function jpegFrameDimensions(base64: string): { width: number; height: number } | null {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let cursor = 2;
  while (cursor + 3 < bytes.length) {
    if (bytes[cursor++] !== 0xff) return null;
    while (bytes[cursor] === 0xff) cursor += 1;
    const marker = bytes[cursor++]!;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (cursor + 1 >= bytes.length) return null;
    const length = bytes.readUInt16BE(cursor);
    if (length < 2 || cursor + length > bytes.length) return null;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 7) return null;
      const height = bytes.readUInt16BE(cursor + 3);
      const width = bytes.readUInt16BE(cursor + 5);
      return width > 0 && width <= 4096 && height > 0 && height <= 4096
        ? { width, height } : null;
    }
    cursor += length;
  }
  return null;
}

export class BrowserLiveFrameMailbox {
  private latest: BrowserLiveFrame | null = null;
  private sequence = 0;
  private closed = false;
  private readonly readers = new Set<(frame: BrowserLiveFrame | null) => void>();

  constructor(
    private readonly options: { maxFrameBytes: number; minFrameIntervalMs: number },
    initialSequence = 0,
  ) { this.sequence = initialSequence; }

  publish(frame: Omit<BrowserLiveFrame, "seq" | "capturedAt">, at = Date.now()): void {
    if (this.closed || Buffer.byteLength(frame.data, "utf8") > this.options.maxFrameBytes ||
        !Number.isInteger(frame.width) || !Number.isInteger(frame.height) ||
        frame.width <= 0 || frame.height <= 0) return;
    if (this.latest && at - this.latest.capturedAt < this.options.minFrameIntervalMs) return;
    this.latest = { ...frame, seq: ++this.sequence, capturedAt: at };
    for (const reader of this.readers) reader(this.latest);
    this.readers.clear();
  }

  async read(afterSeq: number, waitMs: number): Promise<BrowserLiveFrame | null> {
    if (this.closed) return null;
    if (this.latest && this.latest.seq > afterSeq) return this.latest;
    return new Promise((resolve) => {
      const finish = (frame: BrowserLiveFrame | null): void => {
        clearTimeout(timeout);
        this.readers.delete(finish);
        resolve(frame);
      };
      const timeout = setTimeout(() => finish(null), Math.max(0, waitMs));
      this.readers.add(finish);
    });
  }

  close(): void {
    this.closed = true;
    for (const reader of this.readers) reader(null);
    this.readers.clear();
  }
}
