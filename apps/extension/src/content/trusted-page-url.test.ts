import { describe, expect, it } from "vitest";
import { exactTrustedPagePath } from "./trusted-page-url";

const policy = {
  origin: "https://campus.example.jp",
  paths: new Set(["/student/home"]),
};

describe("exactTrustedPagePath", () => {
  it("accepts only the exact HTTPS origin and path", () => {
    expect(
      exactTrustedPagePath("https://campus.example.jp/student/home", policy),
    ).toBe("/student/home");
    expect(
      exactTrustedPagePath("https://evil.example/student/home", policy),
    ).toBeNull();
    expect(
      exactTrustedPagePath("http://campus.example.jp/student/home", policy),
    ).toBeNull();
  });

  it("rejects credentials, query strings, and fragments by default", () => {
    expect(
      exactTrustedPagePath(
        "https://user:pass@campus.example.jp/student/home",
        policy,
      ),
    ).toBeNull();
    expect(
      exactTrustedPagePath(
        "https://campus.example.jp/student/home?session=secret",
        policy,
      ),
    ).toBeNull();
    expect(
      exactTrustedPagePath(
        "https://campus.example.jp/student/home#private",
        policy,
      ),
    ).toBeNull();
  });
});
