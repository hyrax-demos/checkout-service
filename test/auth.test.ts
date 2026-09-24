import { describe, it, expect } from "vitest";
import jwt from "jsonwebtoken";
import {
  signToken,
  verifyToken,
  hashPassword,
  verifyPassword,
} from "../src/auth";

// Deliberately does not assert on `clockTolerance` — that value is a bench
// task's fix target (M4), and a correct fix must still pass this file
// unedited.
describe("auth helpers", () => {
  it("signs and verifies a session token round-trip", () => {
    const token = signToken("user-42");
    const claims = verifyToken(token);
    expect(claims.sub).toBe("user-42");
  });

  it("rejects a token signed with the wrong secret", () => {
    const bad = jwt.sign({ sub: "user-42" }, "not-the-real-secret", {
      algorithm: "HS256",
      expiresIn: 3600,
    });
    expect(() => verifyToken(bad)).toThrow();
  });

  it("hashes and verifies a password", () => {
    const hash = hashPassword("correct horse battery staple");
    expect(verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(verifyPassword("wrong password", hash)).toBe(false);
  });
});
