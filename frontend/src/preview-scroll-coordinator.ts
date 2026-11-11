export type ScrollDelta = { x: number; y: number };
const DEBOUNCE_MS = 45;
const REQUEST_LIMIT = 5000;

// One pending vector replaces an unbounded gesture queue. Requests are serial,
// and movement arriving during an in-flight screenshot is retained for the
// next viewport instead of being discarded.
export class PreviewScrollCoordinator {
  private pending: ScrollDelta = { x: 0, y: 0 };
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private generation = 0;
  constructor(
    private send: (delta: ScrollDelta) => Promise<void>,
    private ready: () => boolean,
    private changed: () => void,
    private drained: () => void,
  ) {}
  get hasPending() { return this.pending.x !== 0 || this.pending.y !== 0; }
  add(delta: ScrollDelta) {
    this.pending.x += delta.x;
    this.pending.y += delta.y;
    if (!this.hasPending) return;
    this.changed();
    this.schedule();
  }
  resume() { if (this.hasPending) this.schedule(); }
  clear() {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = { x: 0, y: 0 };
    this.drained();
  }
  private schedule() {
    if (this.running || this.timer || !this.hasPending) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, DEBOUNCE_MS);
  }
  private async flush() {
    if (this.running || !this.ready() || !this.hasPending) return;
    const delta = { x: Math.max(-REQUEST_LIMIT, Math.min(REQUEST_LIMIT, this.pending.x)), y: Math.max(-REQUEST_LIMIT, Math.min(REQUEST_LIMIT, this.pending.y)) };
    this.pending.x -= delta.x;
    this.pending.y -= delta.y;
    this.running = true;
    const generation = this.generation;
    try { await this.send(delta); }
    catch { /* The picker reports the request failure and offers a fresh Preview. */ }
    finally {
      this.running = false;
      if (generation !== this.generation) return;
      if (this.hasPending) this.schedule();
      else this.drained();
    }
  }
}

export function scrollSteps(delta: ScrollDelta, available: number) {
  const count = Math.max(Math.ceil(Math.abs(delta.x) / REQUEST_LIMIT), Math.ceil(Math.abs(delta.y) / REQUEST_LIMIT));
  if (count > available) return null;
  const steps: ScrollDelta[] = [];
  let x = 0, y = 0;
  for (let index = 1; index <= count; index++) {
    const nextX = Math.round(delta.x * index / count), nextY = Math.round(delta.y * index / count);
    steps.push({ x: nextX - x, y: nextY - y });
    x = nextX; y = nextY;
  }
  return steps;
}
