import { describe, expect, it } from "vitest";
import type { LicenseRecord, LicenseStatus } from "./license.js";
import { authorizeLicenseAction } from "./authorization.js";

const validLicense: LicenseRecord = {
  licenseId: "lic-0001",
  status: "ACTIVE",
  customerId: "cust-0001",
  allowedMt5Logins: [12345678],
  allowedBrokerServers: ["Broker-Live"],
  installationId: "inst-0001",
  installationPublicKey: "device-public-key-placeholder",
  plan: "STANDARD",
  maxAccounts: 1,
  issuedAt: 1_789_000_000_000,
  expiresAt: 1_791_592_000_000,
  revokedAt: null
};

const validRequest = {
  installationId: "inst-0001",
  mt5Login: 12345678,
  brokerServer: "Broker-Live",
  action: "POSITION_OPEN" as const,
  masterPositionRef: "master-pos-1",
  now: 1_789_000_010_000
};

function licenseWithStatus(status: LicenseStatus): LicenseRecord {
  return {
    ...validLicense,
    status,
    revokedAt:
      status === "REVOKED" ? validLicense.issuedAt + 5_000 : null
  };
}

const matchedBuyPosition = {
  masterPositionRef: validRequest.masterPositionRef,
  side: "BUY" as const,
  currentStopLoss: 4386,
  requestedStopLoss: 4388
};

const matchedSellPosition = {
  masterPositionRef: validRequest.masterPositionRef,
  side: "SELL" as const,
  currentStopLoss: 4400,
  requestedStopLoss: 4398
};

describe("active license authorization", () => {
  it("authorizes a matching active license", () => {
    expect(authorizeLicenseAction(validLicense, validRequest)).toEqual({
      ok: true,
      code: "AUTHORIZED",
      effectiveStatus: "ACTIVE"
    });
  });

  it("rejects an installation mismatch", () => {
    expect(
      authorizeLicenseAction(validLicense, {
        ...validRequest,
        installationId: "inst-other"
      })
    ).toEqual({
      ok: false,
      code: "INSTALLATION_MISMATCH"
    });
  });

  it("rejects an MT5 login outside the explicit allowlist", () => {
    expect(
      authorizeLicenseAction(validLicense, {
        ...validRequest,
        mt5Login: 87654321
      })
    ).toEqual({
      ok: false,
      code: "MT5_LOGIN_NOT_ALLOWED"
    });
  });

  it("rejects a broker server outside the explicit allowlist", () => {
    expect(
      authorizeLicenseAction(validLicense, {
        ...validRequest,
        brokerServer: "Broker-Demo"
      })
    ).toEqual({
      ok: false,
      code: "BROKER_SERVER_NOT_ALLOWED"
    });
  });

  it("rejects use before issuedAt", () => {
    expect(
      authorizeLicenseAction(validLicense, {
        ...validRequest,
        now: validLicense.issuedAt - 1
      })
    ).toEqual({
      ok: false,
      code: "LICENSE_NOT_YET_VALID"
    });
  });

  it("treats an elapsed stored ACTIVE license as effectively EXPIRED", () => {
    expect(
      authorizeLicenseAction(validLicense, {
        ...validRequest,
        now: validLicense.expiresAt
      })
    ).toEqual({
      ok: false,
      code: "LICENSE_NOT_ACTIVE",
      effectiveStatus: "EXPIRED"
    });
  });

  it("fails closed on an unknown runtime action", () => {
    expect(
      authorizeLicenseAction(validLicense, {
        ...validRequest,
        action: "RUN_STRATEGY"
      } as never)
    ).toEqual({
      ok: false,
      code: "INVALID_REQUEST"
    });
  });

  it("fails closed on a blank master position reference", () => {
    expect(
      authorizeLicenseAction(validLicense, {
        ...validRequest,
        masterPositionRef: ""
      })
    ).toEqual({
      ok: false,
      code: "INVALID_REQUEST"
    });
  });

  it("fails closed on a malformed runtime license", () => {
    expect(
      authorizeLicenseAction(
        { ...validLicense, allowedMt5Logins: [] } as LicenseRecord,
        validRequest
      )
    ).toEqual({
      ok: false,
      code: "INVALID_LICENSE_RECORD"
    });
  });
});

describe.each(["SUSPENDED", "EXPIRED", "REVOKED"] as const)(
  "%s license action matrix",
  (status) => {
    const license = licenseWithStatus(status);

    it("blocks new exposure", () => {
      expect(authorizeLicenseAction(license, validRequest)).toEqual({
        ok: false,
        code: "LICENSE_NOT_ACTIVE",
        effectiveStatus: status
      });
    });

    it("blocks take-profit changes", () => {
      expect(
        authorizeLicenseAction(license, {
          ...validRequest,
          action: "TAKE_PROFIT_UPDATE"
        })
      ).toEqual({
        ok: false,
        code: "ACTION_NOT_ALLOWED_FOR_LICENSE_STATE",
        effectiveStatus: status
      });
    });

    it.each(["PARTIAL_CLOSE", "POSITION_CLOSE", "POSITION_SNAPSHOT"] as const)(
      "requires an existing matched position for %s",
      (action) => {
        expect(
          authorizeLicenseAction(license, {
            ...validRequest,
            action
          })
        ).toEqual({
          ok: false,
          code: "EXISTING_POSITION_REQUIRED",
          effectiveStatus: status
        });
      }
    );

    it("rejects a mismatched existing position", () => {
      expect(
        authorizeLicenseAction(license, {
          ...validRequest,
          action: "POSITION_CLOSE",
          existingPosition: {
            ...matchedBuyPosition,
            masterPositionRef: "master-pos-other"
          }
        })
      ).toEqual({
        ok: false,
        code: "POSITION_MISMATCH",
        effectiveStatus: status
      });
    });

    it.each(["PARTIAL_CLOSE", "POSITION_CLOSE", "POSITION_SNAPSHOT"] as const)(
      "authorizes matched risk-reducing/reconcile action %s",
      (action) => {
        expect(
          authorizeLicenseAction(license, {
            ...validRequest,
            action,
            existingPosition: matchedBuyPosition
          })
        ).toEqual({
          ok: true,
          code: "AUTHORIZED",
          effectiveStatus: status
        });
      }
    );
  }
);

describe("elapsed ACTIVE license uses EXPIRED matrix", () => {
  it("permits a matched close after expiration", () => {
    expect(
      authorizeLicenseAction(validLicense, {
        ...validRequest,
        action: "POSITION_CLOSE",
        now: validLicense.expiresAt,
        existingPosition: matchedBuyPosition
      })
    ).toEqual({
      ok: true,
      code: "AUTHORIZED",
      effectiveStatus: "EXPIRED"
    });
  });
});

describe("non-active STOP_LOSS_UPDATE risk reduction", () => {
  const suspended = licenseWithStatus("SUSPENDED");

  it.each([
    ["BUY", 4386, 4388],
    ["BUY", 4386, 4386],
    ["SELL", 4400, 4398],
    ["SELL", 4400, 4400]
  ] as const)(
    "authorizes non-loosening %s stop %s -> %s",
    (side, currentStopLoss, requestedStopLoss) => {
      expect(
        authorizeLicenseAction(suspended, {
          ...validRequest,
          action: "STOP_LOSS_UPDATE",
          existingPosition: {
            masterPositionRef: validRequest.masterPositionRef,
            side,
            currentStopLoss,
            requestedStopLoss
          }
        })
      ).toEqual({
        ok: true,
        code: "AUTHORIZED",
        effectiveStatus: "SUSPENDED"
      });
    }
  );

  it.each([
    ["BUY", 4386, 4385],
    ["SELL", 4400, 4401]
  ] as const)(
    "rejects loosening %s stop %s -> %s",
    (side, currentStopLoss, requestedStopLoss) => {
      expect(
        authorizeLicenseAction(suspended, {
          ...validRequest,
          action: "STOP_LOSS_UPDATE",
          existingPosition: {
            masterPositionRef: validRequest.masterPositionRef,
            side,
            currentStopLoss,
            requestedStopLoss
          }
        })
      ).toEqual({
        ok: false,
        code: "STOP_LOSS_NOT_RISK_REDUCING",
        effectiveStatus: "SUSPENDED"
      });
    }
  );

  it.each([matchedBuyPosition, matchedSellPosition])(
    "authorizes first protective stop when current stop is absent",
    (position) => {
      expect(
        authorizeLicenseAction(suspended, {
          ...validRequest,
          action: "STOP_LOSS_UPDATE",
          existingPosition: {
            ...position,
            currentStopLoss: null
          }
        })
      ).toEqual({
        ok: true,
        code: "AUTHORIZED",
        effectiveStatus: "SUSPENDED"
      });
    }
  );

  it("requires requested stop-loss context", () => {
    expect(
      authorizeLicenseAction(suspended, {
        ...validRequest,
        action: "STOP_LOSS_UPDATE",
        existingPosition: {
          masterPositionRef: validRequest.masterPositionRef,
          side: "BUY",
          currentStopLoss: 4386
        }
      })
    ).toEqual({
      ok: false,
      code: "STOP_LOSS_CONTEXT_REQUIRED",
      effectiveStatus: "SUSPENDED"
    });
  });

  it.each([NaN, Infinity, -Infinity, 0, -1])(
    "fails closed on invalid requested stop %s",
    (requestedStopLoss) => {
      expect(
        authorizeLicenseAction(suspended, {
          ...validRequest,
          action: "STOP_LOSS_UPDATE",
          existingPosition: {
            masterPositionRef: validRequest.masterPositionRef,
            side: "BUY",
            currentStopLoss: 4386,
            requestedStopLoss
          }
        })
      ).toEqual({
        ok: false,
        code: "INVALID_REQUEST"
      });
    }
  );
});
