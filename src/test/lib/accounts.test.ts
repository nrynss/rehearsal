import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAccount,
  isAnonymousUser,
  linkWithProvider,
  resetPassword,
  setNewPassword,
  signIn,
  signOutSession,
} from "../../lib/accounts";

// accounts.ts imports { ensureAnonSession, supabase } from ../lib/config.
// vi.mock hoists; the mock factory supplies a fake client. vi.hoisted is
// required because the factory is hoisted above this file's consts.
const mockChain = vi.hoisted(() => ({
  supabase: {
    auth: {
      updateUser: vi.fn(),
      signInWithPassword: vi.fn(),
      getUser: vi.fn(),
      signOut: vi.fn(),
      linkIdentity: vi.fn(),
      resetPasswordForEmail: vi.fn(),
    },
  },
  ensureAnonSession: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../lib/config", () => ({
  supabase: mockChain.supabase,
  ensureAnonSession: (...args: unknown[]) => mockChain.ensureAnonSession(...args),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("createAccount", () => {
  it("upgrades the anonymous user in place via updateUser", async () => {
    mockChain.supabase.auth.updateUser.mockResolvedValue({ data: { user: {} }, error: null });
    const result = await createAccount("  A@B.com  ", "secret123");
    expect(result).toEqual({ ok: true });
    expect(mockChain.supabase.auth.updateUser).toHaveBeenCalledWith(
      { email: "A@B.com", password: "secret123" },
      { emailRedirectTo: window.location.origin },
    );
  });

  it("maps an invalid_credentials error to a friendly line", async () => {
    mockChain.supabase.auth.updateUser.mockResolvedValue({
      data: { user: null },
      error: { code: "invalid_credentials", message: "Invalid login credentials" },
    });
    const result = await createAccount("a@b.com", "wrong");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/don't match an account/i);
  });

  it("maps a taken email to a sign-in suggestion", async () => {
    mockChain.supabase.auth.updateUser.mockResolvedValue({
      data: { user: null },
      error: { code: "email_exists", message: "A user with this email address has already been registered" },
    });
    const result = await createAccount("a@b.com", "secret123");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/sign in instead/i);
  });

  it("never surfaces a raw Supabase error string", async () => {
    mockChain.supabase.auth.updateUser.mockResolvedValue({
      data: { user: null },
      error: { code: "some_gotrue_code", message: "raw gotrue detail" },
    });
    const result = await createAccount("a@b.com", "secret123");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).not.toContain("raw gotrue detail");
  });
});

describe("signIn", () => {
  it("calls signInWithPassword and succeeds", async () => {
    mockChain.supabase.auth.signInWithPassword.mockResolvedValue({ data: { user: {}, session: {} }, error: null });
    const result = await signIn("a@b.com", "secret123");
    expect(result).toEqual({ ok: true });
    expect(mockChain.supabase.auth.signInWithPassword).toHaveBeenCalledWith({
      email: "a@b.com",
      password: "secret123",
    });
  });

  it("maps an invalid_credentials error to a friendly line", async () => {
    mockChain.supabase.auth.signInWithPassword.mockResolvedValue({
      data: { user: null, session: null },
      error: { code: "invalid_credentials", message: "Invalid login credentials" },
    });
    const result = await signIn("a@b.com", "wrong");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/don't match an account/i);
  });

  it("never surfaces a raw Supabase error string", async () => {
    mockChain.supabase.auth.signInWithPassword.mockResolvedValue({
      data: { user: null, session: null },
      error: { code: "some_code", message: "raw gotrue detail" },
    });
    const result = await signIn("a@b.com", "secret123");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).not.toContain("raw gotrue detail");
  });
});

describe("isAnonymousUser", () => {
  it("returns true for an anonymous user", async () => {
    mockChain.supabase.auth.getUser.mockResolvedValue({
      data: { user: { is_anonymous: true } },
      error: null,
    });
    await expect(isAnonymousUser()).resolves.toBe(true);
  });

  it("returns false for a permanent user", async () => {
    mockChain.supabase.auth.getUser.mockResolvedValue({
      data: { user: { is_anonymous: false } },
      error: null,
    });
    await expect(isAnonymousUser()).resolves.toBe(false);
  });

  it("returns true (safe default) when the check fails", async () => {
    mockChain.supabase.auth.getUser.mockResolvedValue({ data: { user: null }, error: { message: "boom" } });
    await expect(isAnonymousUser()).resolves.toBe(true);
  });
});

describe("signOutSession", () => {
  it("signs out and returns to an anonymous session", async () => {
    mockChain.supabase.auth.signOut.mockResolvedValue({ error: null });
    await expect(signOutSession()).resolves.toBe(true);
    expect(mockChain.ensureAnonSession).toHaveBeenCalled();
  });

  it("reports failure when sign-out errors", async () => {
    mockChain.supabase.auth.signOut.mockResolvedValue({ error: { message: "boom" } });
    await expect(signOutSession()).resolves.toBe(false);
  });
});

describe("linkWithProvider", () => {
  it("awaits an anonymous session, then links GitHub with a redirect to the origin", async () => {
    mockChain.supabase.auth.linkIdentity.mockResolvedValue({ data: { url: "https://github.com/login/oauth/authorize" }, error: null });
    const result = await linkWithProvider("github");
    expect(result).toEqual({ ok: true });
    expect(mockChain.ensureAnonSession).toHaveBeenCalled();
    expect(mockChain.supabase.auth.linkIdentity).toHaveBeenCalledWith({
      provider: "github",
      options: { redirectTo: window.location.origin },
    });
  });

  it("links Discord the same way", async () => {
    mockChain.supabase.auth.linkIdentity.mockResolvedValue({ data: { url: "https://discord.com/oauth2/authorize" }, error: null });
    const result = await linkWithProvider("discord");
    expect(result).toEqual({ ok: true });
    expect(mockChain.supabase.auth.linkIdentity).toHaveBeenCalledWith({
      provider: "discord",
      options: { redirectTo: window.location.origin },
    });
  });

  it("maps a manual-linking-off 422 to a friendly line", async () => {
    mockChain.supabase.auth.linkIdentity.mockResolvedValue({
      data: { url: null },
      error: { code: "422", message: "Manual linking is disabled" },
    });
    const result = await linkWithProvider("github");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/couldn't add an account right now/i);
  });

  it("never surfaces a raw Supabase error string", async () => {
    mockChain.supabase.auth.linkIdentity.mockResolvedValue({
      data: { url: null },
      error: { code: "some_code", message: "raw gotrue detail" },
    });
    const result = await linkWithProvider("github");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).not.toContain("raw gotrue detail");
  });
});

describe("resetPassword", () => {
  it("calls resetPasswordForEmail with redirectTo the origin", async () => {
    mockChain.supabase.auth.resetPasswordForEmail.mockResolvedValue({ data: {}, error: null });
    const result = await resetPassword("  a@b.com  ");
    expect(result).toEqual({ ok: true });
    expect(mockChain.supabase.auth.resetPasswordForEmail).toHaveBeenCalledWith("a@b.com", {
      redirectTo: window.location.origin,
    });
  });

  it("maps a failure to a friendly line, never a raw error", async () => {
    mockChain.supabase.auth.resetPasswordForEmail.mockResolvedValue({
      data: {},
      error: { code: "over_email_send_rate_limit", message: "Rate limit exceeded" },
    });
    const result = await resetPassword("a@b.com");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/too many attempts/i);
  });
});

describe("setNewPassword", () => {
  it("calls updateUser with just the password", async () => {
    mockChain.supabase.auth.updateUser.mockResolvedValue({ data: { user: {} }, error: null });
    const result = await setNewPassword("newsecret123");
    expect(result).toEqual({ ok: true });
    expect(mockChain.supabase.auth.updateUser).toHaveBeenCalledWith({ password: "newsecret123" });
  });
});
