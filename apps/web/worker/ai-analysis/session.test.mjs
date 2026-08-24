import { beforeEach, describe, expect, it, vi } from "vitest";

const { createAuthMock, getSessionMock } = vi.hoisted(() => ({
  createAuthMock: vi.fn(),
  getSessionMock: vi.fn(),
}));

vi.mock("../auth/auth", () => ({ createAuth: createAuthMock }));

import { AiAnalysisAuthUnavailableError, readAuthenticatedAiUser } from "./session";

const request = new Request("https://app.test/api/ai-analysis/viewer", {
  headers: { cookie: "better-auth.session_token=opaque" },
});

const configuredEnv = {
  DB: {},
  BETTER_AUTH_SECRET: "test-secret",
  BETTER_AUTH_URL: "https://app.test",
};

beforeEach(() => {
  createAuthMock.mockReset();
  getSessionMock.mockReset();
  createAuthMock.mockReturnValue({ api: { getSession: getSessionMock } });
});

describe("AI Analysis Better Auth session boundary", () => {
  it("fails closed before adapter initialization when runtime auth configuration is absent", async () => {
    await expect(readAuthenticatedAiUser(request, { DB: {} })).rejects.toBeInstanceOf(AiAnalysisAuthUnavailableError);
    expect(createAuthMock).not.toHaveBeenCalled();
  });

  it("uses Better Auth's server API with the original request headers", async () => {
    getSessionMock.mockResolvedValue({ user: { id: "user-1" }, session: { id: "session-1" } });
    await expect(readAuthenticatedAiUser(request, configuredEnv)).resolves.toEqual({ id: "user-1" });
    expect(createAuthMock).toHaveBeenCalledWith(configuredEnv.DB, configuredEnv.BETTER_AUTH_URL, configuredEnv.BETTER_AUTH_SECRET);
    expect(getSessionMock).toHaveBeenCalledWith({ headers: request.headers });
  });

  it("returns null for an unusable session/empty id and sanitizes adapter failures", async () => {
    getSessionMock.mockResolvedValueOnce(null);
    await expect(readAuthenticatedAiUser(request, configuredEnv)).resolves.toBeNull();
    getSessionMock.mockResolvedValueOnce({ user: { id: "" }, session: { id: "session-1" } });
    await expect(readAuthenticatedAiUser(request, configuredEnv)).resolves.toBeNull();
    getSessionMock.mockRejectedValueOnce(new Error("database/token detail"));
    await expect(readAuthenticatedAiUser(request, configuredEnv)).rejects.toBeInstanceOf(AiAnalysisAuthUnavailableError);
  });
});
