import {
  getCustomerGrantAdminView,
  listCustomerGrantAdminViews,
  registerCustomerGrant,
  revokeRegisteredCustomerGrant,
  type CustomerGrantAdminQuery,
  type CustomerGrantAdminView,
  type CustomerGrantRegistryRepository,
  type RegisterCustomerGrantDecision,
  type RevokeRegisteredCustomerGrantDecision,
} from "@xauusd/customer-grant-registry";
import {
  assertCustomerProductGrantLifecycleRecord,
  type CustomerProductGrantLifecycleRecord,
} from "@xauusd/customer-product-access";

export const CUSTOMER_GRANT_ADMIN_ACTIONS = [
  "READ_GRANT",
  "LIST_GRANTS",
  "REGISTER_GRANT",
  "REVOKE_GRANT",
] as const;

export type CustomerGrantAdminAction =
  (typeof CUSTOMER_GRANT_ADMIN_ACTIONS)[number];

export interface CustomerGrantAdminActor {
  readonly subjectId: string;
}

export interface CustomerGrantAdminAuthorizationRequest {
  readonly actor: CustomerGrantAdminActor;
  readonly action: CustomerGrantAdminAction;
  readonly grantId?: string;
}

export interface CustomerGrantAdminAuthorizer {
  authorize(
    request: CustomerGrantAdminAuthorizationRequest,
  ): Promise<boolean>;
}

export type CustomerGrantAdminCommand =
  | {
      readonly version: 1;
      readonly operation: "GET_GRANT";
      readonly grantId: string;
      readonly now: number;
    }
  | {
      readonly version: 1;
      readonly operation: "LIST_GRANTS";
      readonly query: CustomerGrantAdminQuery;
      readonly now: number;
    }
  | {
      readonly version: 1;
      readonly operation: "REGISTER_GRANT";
      readonly lifecycle: CustomerProductGrantLifecycleRecord;
      readonly now: number;
    }
  | {
      readonly version: 1;
      readonly operation: "REVOKE_GRANT";
      readonly grantId: string;
      readonly revokedAt: number;
      readonly now: number;
    };

export type CustomerGrantAdminCommandResult =
  | {
      readonly ok: false;
      readonly code: "INVALID_ADMIN_ACTOR" | "INVALID_COMMAND" | "ADMIN_FORBIDDEN";
    }
  | {
      readonly ok: true;
      readonly code: "GRANT_READ";
      readonly view: CustomerGrantAdminView | null;
    }
  | {
      readonly ok: true;
      readonly code: "GRANTS_LISTED";
      readonly views: readonly CustomerGrantAdminView[];
    }
  | {
      readonly ok: true;
      readonly code: "REGISTER_DECISION";
      readonly decision: RegisterCustomerGrantDecision;
    }
  | {
      readonly ok: true;
      readonly code: "REVOKE_DECISION";
      readonly decision: RevokeRegisteredCustomerGrantDecision;
    };

const OPERATION_KEYS: Readonly<Record<CustomerGrantAdminCommand["operation"], readonly string[]>> =
  Object.freeze({
    GET_GRANT: Object.freeze(["version", "operation", "grantId", "now"]),
    LIST_GRANTS: Object.freeze(["version", "operation", "query", "now"]),
    REGISTER_GRANT: Object.freeze([
      "version",
      "operation",
      "lifecycle",
      "now",
    ]),
    REVOKE_GRANT: Object.freeze([
      "version",
      "operation",
      "grantId",
      "revokedAt",
      "now",
    ]),
  });

function isCanonicalNonBlankString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim().length > 0 &&
    value.trim() === value
  );
}

function isSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

function isValidAdminQuery(value: unknown): value is CustomerGrantAdminQuery {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const query = value as Record<string, unknown>;
  const allowed = [
    "customerId",
    "licenseId",
    "installationId",
    "productMode",
    "lifecycleStatus",
  ] as const;

  for (const key of Object.keys(query)) {
    if (!(allowed as readonly string[]).includes(key)) {
      return false;
    }
  }

  for (const field of ["customerId", "licenseId", "installationId"] as const) {
    if (
      query[field] !== undefined &&
      !isCanonicalNonBlankString(query[field])
    ) {
      return false;
    }
  }

  if (
    query.productMode !== undefined &&
    query.productMode !== "SELF_MANAGED" &&
    query.productMode !== "COPY_FOLLOWER"
  ) {
    return false;
  }

  if (
    query.lifecycleStatus !== undefined &&
    query.lifecycleStatus !== "ACTIVE" &&
    query.lifecycleStatus !== "REVOKED"
  ) {
    return false;
  }

  return true;
}

function isValidLifecycle(
  value: unknown,
): value is CustomerProductGrantLifecycleRecord {
  try {
    assertCustomerProductGrantLifecycleRecord(value);
    return true;
  } catch {
    return false;
  }
}

function validExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === allowed.length &&
    [...allowed].sort().every((key, index) => key === keys[index])
  );
}

function isValidActor(actor: unknown): actor is CustomerGrantAdminActor {
  return (
    actor !== null &&
    typeof actor === "object" &&
    !Array.isArray(actor) &&
    validExactKeys(actor as Record<string, unknown>, ["subjectId"]) &&
    isCanonicalNonBlankString(
      (actor as Record<string, unknown>).subjectId,
    )
  );
}

function commandAction(
  command: CustomerGrantAdminCommand,
): CustomerGrantAdminAction {
  switch (command.operation) {
    case "GET_GRANT":
      return "READ_GRANT";
    case "LIST_GRANTS":
      return "LIST_GRANTS";
    case "REGISTER_GRANT":
      return "REGISTER_GRANT";
    case "REVOKE_GRANT":
      return "REVOKE_GRANT";
  }
}

function commandGrantId(
  command: CustomerGrantAdminCommand,
): string | undefined {
  switch (command.operation) {
    case "GET_GRANT":
    case "REVOKE_GRANT":
      return command.grantId;
    case "REGISTER_GRANT":
      return command.lifecycle?.grant?.grantId;
    case "LIST_GRANTS":
      return undefined;
  }
}

function isValidCommand(value: unknown): value is CustomerGrantAdminCommand {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const command = value as Record<string, unknown>;
  if (
    command.version !== 1 ||
    typeof command.operation !== "string" ||
    !(command.operation in OPERATION_KEYS)
  ) {
    return false;
  }

  const operation = command.operation as CustomerGrantAdminCommand["operation"];
  if (!validExactKeys(command, OPERATION_KEYS[operation])) {
    return false;
  }

  if (!isSafeInteger(command.now)) {
    return false;
  }

  if (operation === "GET_GRANT") {
    return isCanonicalNonBlankString(command.grantId);
  }

  if (operation === "LIST_GRANTS") {
    return isValidAdminQuery(command.query);
  }

  if (operation === "REGISTER_GRANT") {
    return isValidLifecycle(command.lifecycle);
  }

  return (
    isCanonicalNonBlankString(command.grantId) &&
    isSafeInteger(command.revokedAt)
  );
}

export async function executeCustomerGrantAdminCommand(
  repository: CustomerGrantRegistryRepository,
  authorizer: CustomerGrantAdminAuthorizer,
  actor: unknown,
  command: unknown,
): Promise<CustomerGrantAdminCommandResult> {
  if (!isValidActor(actor)) {
    return { ok: false, code: "INVALID_ADMIN_ACTOR" };
  }

  if (!isValidCommand(command)) {
    return { ok: false, code: "INVALID_COMMAND" };
  }

  const allowed = await authorizer.authorize({
    actor,
    action: commandAction(command),
    grantId: commandGrantId(command),
  });

  if (!allowed) {
    return { ok: false, code: "ADMIN_FORBIDDEN" };
  }

  switch (command.operation) {
    case "GET_GRANT":
      return {
        ok: true,
        code: "GRANT_READ",
        view: await getCustomerGrantAdminView(
          repository,
          command.grantId,
          command.now,
        ),
      };

    case "LIST_GRANTS":
      try {
        return {
          ok: true,
          code: "GRANTS_LISTED",
          views: await listCustomerGrantAdminViews(
            repository,
            command.query,
            command.now,
          ),
        };
      } catch {
        return { ok: false, code: "INVALID_COMMAND" };
      }

    case "REGISTER_GRANT":
      return {
        ok: true,
        code: "REGISTER_DECISION",
        decision: await registerCustomerGrant(
          repository,
          command.lifecycle,
        ),
      };

    case "REVOKE_GRANT":
      return {
        ok: true,
        code: "REVOKE_DECISION",
        decision: await revokeRegisteredCustomerGrant(
          repository,
          command.grantId,
          command.revokedAt,
        ),
      };
  }
}
