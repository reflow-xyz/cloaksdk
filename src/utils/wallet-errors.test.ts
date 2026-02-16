import { describe, it, expect } from "vitest";

import { isUserRejectedError } from "./wallet-errors";

describe("isUserRejectedError", () => {
  it("detects code=4001", () => {
    expect(isUserRejectedError({ code: 4001 })).toBe(true);
    expect(isUserRejectedError({ error: { code: 4001 } })).toBe(true);
  });

  it("detects wallet adapter style names/messages", () => {
    expect(
      isUserRejectedError({ name: "WalletSignTransactionError", message: "User rejected the request." }),
    ).toBe(true);
    expect(isUserRejectedError(new Error("User rejected the request."))).toBe(true);
  });

  it("does not false positive", () => {
    expect(isUserRejectedError(null)).toBe(false);
    expect(isUserRejectedError({ code: 123 })).toBe(false);
    expect(isUserRejectedError(new Error("some other error"))).toBe(false);
  });
});

