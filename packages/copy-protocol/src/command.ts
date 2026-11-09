export const COPY_COMMAND_ACTIONS = [
  "POSITION_OPEN",
  "STOP_LOSS_UPDATE",
  "TAKE_PROFIT_UPDATE",
  "PARTIAL_CLOSE",
  "POSITION_CLOSE",
  "POSITION_SNAPSHOT"
] as const;

export type CopyCommandAction = (typeof COPY_COMMAND_ACTIONS)[number];
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export type JsonObject = { readonly [key: string]: JsonValue };

export interface CopyCommandBody {
  readonly version: 1;
  readonly commandId: string;
  readonly sequence: number;
  readonly licenseId: string;
  readonly installationId: string;
  readonly mt5Login: number;
  readonly brokerServer: string;
  readonly symbol: string;
  readonly action: CopyCommandAction;
  readonly payload: JsonObject;
  readonly masterPositionRef: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly keyId: string;
}

export interface SignedCopyCommand extends CopyCommandBody {
  readonly signature: string;
}

const REQUIRED_KEYS = new Set([
  "version",
  "commandId",
  "sequence",
  "licenseId",
  "installationId",
  "mt5Login",
  "brokerServer",
  "symbol",
  "action",
  "payload",
  "masterPositionRef",
  "issuedAt",
  "expiresAt",
  "keyId"
]);

function assertNonBlankString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-blank string`);
  }
}

function assertPositiveSafeInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
}

function assertSafeInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${field} must be a safe integer`);
  }
}

function assertJsonValue(value: unknown, field: string, seen: WeakSet<object>): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${field} must contain only finite JSON numbers`);
    }
    return;
  }

  if (typeof value !== "object") {
    throw new TypeError(`${field} must contain only JSON values`);
  }

  if (seen.has(value)) {
    throw new TypeError(`${field} must not contain cyclic values`);
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) {
        throw new TypeError(`${field} must not contain sparse arrays`);
      }
      assertJsonValue(value[index], `${field}[${index}]`, seen);
    }
    seen.delete(value);
    return;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${field} must contain only plain objects`);
  }

  for (const [key, nested] of Object.entries(value)) {
    assertJsonValue(nested, `${field}.${key}`, seen);
  }
  seen.delete(value);
}

export function assertCopyCommandBody(value: unknown): asserts value is CopyCommandBody {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("command body must be an object");
  }

  const body = value as Record<string, unknown>;
  const keys = Object.keys(body);
  for (const key of keys) {
    if (!REQUIRED_KEYS.has(key)) {
      throw new TypeError(`command body contains unknown field: ${key}`);
    }
  }
  for (const key of REQUIRED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) {
      throw new TypeError(`command body is missing field: ${key}`);
    }
  }

  if (body.version !== 1) {
    throw new TypeError("version must be 1");
  }

  assertNonBlankString(body.commandId, "commandId");
  assertPositiveSafeInteger(body.sequence, "sequence");
  assertNonBlankString(body.licenseId, "licenseId");
  assertNonBlankString(body.installationId, "installationId");
  assertPositiveSafeInteger(body.mt5Login, "mt5Login");
  assertNonBlankString(body.brokerServer, "brokerServer");
  assertNonBlankString(body.symbol, "symbol");
  assertNonBlankString(body.masterPositionRef, "masterPositionRef");
  assertNonBlankString(body.keyId, "keyId");

  if (!COPY_COMMAND_ACTIONS.includes(body.action as CopyCommandAction)) {
    throw new TypeError("action must be a V1 allowlisted copy command action");
  }

  if (body.payload === null || typeof body.payload !== "object" || Array.isArray(body.payload)) {
    throw new TypeError("payload must be a JSON object");
  }
  assertJsonValue(body.payload, "payload", new WeakSet<object>());

  assertSafeInteger(body.issuedAt, "issuedAt");
  assertSafeInteger(body.expiresAt, "expiresAt");
  if ((body.expiresAt as number) <= (body.issuedAt as number)) {
    throw new TypeError("expiresAt must be greater than issuedAt");
  }
}
