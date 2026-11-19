import type { IClock } from "../contracts";

export class SystemClock implements IClock {
  now(): number {
    return Date.now();
  }
}
