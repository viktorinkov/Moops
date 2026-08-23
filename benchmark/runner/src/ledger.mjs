import { appendFile, writeFile } from "node:fs/promises";

export class EventLedger {
  constructor(path, options = {}) {
    this.path = path;
    this.wallNow = options.wallNow ?? (() => Date.now());
    this.monotonicNow = options.monotonicNow ?? (() => process.hrtime.bigint());
    this.sequence = 0;
    this.queue = Promise.resolve();
  }

  async initialize() {
    await writeFile(this.path, "", { flag: "wx" });
  }

  async emit(type, data = {}) {
    const epochMs = this.wallNow();
    const record = {
      eventVersion: 1,
      ...data,
      sequence: ++this.sequence,
      type,
      wallTime: new Date(epochMs).toISOString(),
      epochMs,
      monotonicNs: this.monotonicNow().toString(),
    };
    const line = `${JSON.stringify(record)}\n`;
    this.queue = this.queue.then(() => appendFile(this.path, line, "utf8"));
    await this.queue;
    return record;
  }

  async close() {
    await this.queue;
  }
}
