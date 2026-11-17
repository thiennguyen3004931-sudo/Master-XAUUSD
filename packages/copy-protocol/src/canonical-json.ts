import type { CopyCommandBody, JsonValue } from "./command.js";
import { assertCopyCommandBody } from "./command.js";

function canonicalizeJsonInternal(value: unknown, seen: WeakSet<object>): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonical JSON number must be finite");
    }
    return JSON.stringify(value);
  }

  if (typeof value !== "object") {
    throw new TypeError("canonical JSON value is unsupported");
  }

  if (seen.has(value)) {
    throw new TypeError("canonical JSON value must not be cyclic");
  }
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new TypeError("canonical JSON array must not be sparse");
        }
        items.push(canonicalizeJsonInternal(value[index], seen));
      }
      return `[${items.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("canonical JSON object must be plain");
    }

    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalizeJsonInternal(record[key], seen)}`
      )
      .join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

export function canonicalizeJson(value: JsonValue): string {
  return canonicalizeJsonInternal(value, new WeakSet<object>());
}

export function canonicalizeCopyCommandBody(body: CopyCommandBody): string {
  assertCopyCommandBody(body);
  return canonicalizeJson(body as unknown as JsonValue);
}

export function copyCommandSigningBytes(body: CopyCommandBody): Uint8Array {
  return new TextEncoder().encode(canonicalizeCopyCommandBody(body));
}
