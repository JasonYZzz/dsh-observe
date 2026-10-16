import { Worker } from 'node:worker_threads';
import type { Health } from './types.js';

export class Store {
  private worker: Worker;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private sequence = 0;
  private closed = false;
  private failure?: Error;
  readonly ready: Promise<void>;

  constructor(directory: string) {
    this.worker = new Worker(new URL('./store-worker.js', import.meta.url), { workerData: { directory } });
    this.ready = new Promise((resolve, reject) => {
      this.worker.on('message', (message) => {
        if (message.ready) return resolve();
        if (message.fatal) {
          this.failure = new Error(message.fatal);
          reject(this.failure);
          this.failPending(this.failure);
          return;
        }
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.value);
      });
      this.worker.on('error', (error) => {
        this.failure = error;
        reject(error);
        this.failPending(error);
      });
      this.worker.on('exit', () => {
        const error = new Error('Observation worker stopped');
        this.failure = error;
        reject(error);
        this.failPending(error);
      });
    });
  }

  private failPending(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async call<T>(operation: string, payload?: unknown): Promise<T> {
    await this.ready;
    if (this.closed || this.failure) throw this.failure ?? new Error('Observation store closed');
    if (this.pending.size >= 1024) throw new Error('Observation queue full');
    return new Promise<T>((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Observation store timed out'));
      }, 15_000);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      this.worker.postMessage({ id, operation, payload });
    });
  }

  health() { return this.call<Health['database']>('health'); }

  async close() {
    if (this.closed || this.worker.threadId === -1) return;
    this.closed = true;
    const exited = new Promise<void>((resolve) => this.worker.once('exit', () => resolve()));
    const timeout = setTimeout(() => { void this.worker.terminate(); }, 5000);
    this.worker.postMessage({ operation: 'close' });
    try { await exited; } finally { clearTimeout(timeout); }
  }
}
