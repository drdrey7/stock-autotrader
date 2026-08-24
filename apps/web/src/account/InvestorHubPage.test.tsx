import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  useSession: vi.fn(),
  refetch: vi.fn(),
  signInEmail: vi.fn(),
  signUpEmail: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("../lib/auth-client", () => ({
  authClient: {
    useSession: authMocks.useSession,
    signIn: { email: authMocks.signInEmail },
    signUp: { email: authMocks.signUpEmail },
    signOut: authMocks.signOut,
  },
}));

vi.mock("./AiAnalysisAccount", () => ({
  AiAnalysisAccount: () => <section aria-label="AI analysis account test section" />,
}));

import InvestorHubPage from "./InvestorHubPage";

function renderHub() {
  return render(<MemoryRouter><InvestorHubPage /></MemoryRouter>);
}

beforeEach(() => {
  authMocks.refetch.mockResolvedValue(undefined);
  authMocks.signInEmail.mockResolvedValue({ data: {}, error: null });
  authMocks.signUpEmail.mockResolvedValue({ data: {}, error: null });
  authMocks.signOut.mockResolvedValue({ data: {}, error: null });
  authMocks.useSession.mockReturnValue({
    data: null,
    isPending: false,
    error: null,
    refetch: authMocks.refetch,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Investor Hub", () => {
  it("signs in with email/password and refreshes the session", async () => {
    renderHub();
    const form = screen.getByRole("form", { name: "Sign in form" });

    fireEvent.change(within(form).getByLabelText("Email"), { target: { value: "person@example.com" } });
    fireEvent.change(within(form).getByLabelText("Password"), { target: { value: "password123" } });
    fireEvent.click(within(form).getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(authMocks.signInEmail).toHaveBeenCalledWith({
        email: "person@example.com",
        password: "password123",
        rememberMe: true,
      });
    });
    expect(authMocks.refetch).toHaveBeenCalledTimes(1);
  });

  it("creates an account with name, email and password", async () => {
    renderHub();

    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    const form = screen.getByRole("form", { name: "Create account form" });
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: " Test User " } });
    fireEvent.change(within(form).getByLabelText("Email"), { target: { value: " test@example.com " } });
    fireEvent.change(within(form).getByLabelText(/^Password/), { target: { value: "password123" } });
    fireEvent.click(within(form).getByRole("button", { name: "Create my account" }));

    await waitFor(() => {
      expect(authMocks.signUpEmail).toHaveBeenCalledWith({
        name: "Test User",
        email: "test@example.com",
        password: "password123",
      });
    });
    expect(authMocks.refetch).toHaveBeenCalledTimes(1);
  });

  it("shows the authenticated profile and signs out", async () => {
    authMocks.useSession.mockReturnValue({
      data: {
        user: { name: "Test User", email: "test@example.com" },
        session: { id: "session-1" },
      },
      isPending: false,
      error: null,
      refetch: authMocks.refetch,
    });

    renderHub();

    expect(screen.getByRole("heading", { name: "Test User" })).toBeInTheDocument();
    expect(screen.getByText("test@example.com")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(authMocks.signOut).toHaveBeenCalledTimes(1));
    expect(authMocks.refetch).toHaveBeenCalledTimes(1);
  });

  it("clears retained personal fields after sign out", async () => {
    const signedOutSession = {
      data: null,
      isPending: false,
      error: null,
      refetch: authMocks.refetch,
    };
    const authenticatedSession = {
      data: {
        user: { name: "Test User", email: "test@example.com" },
        session: { id: "session-1" },
      },
      isPending: false,
      error: null,
      refetch: authMocks.refetch,
    };

    authMocks.useSession.mockReturnValue(signedOutSession);
    const { rerender } = render(<MemoryRouter><InvestorHubPage /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    const signUpForm = screen.getByRole("form", { name: "Create account form" });
    fireEvent.change(within(signUpForm).getByLabelText("Name"), { target: { value: "Test User" } });
    fireEvent.change(within(signUpForm).getByLabelText("Email"), { target: { value: "test@example.com" } });
    fireEvent.change(within(signUpForm).getByLabelText(/^Password/), { target: { value: "password123" } });

    authMocks.useSession.mockReturnValue(authenticatedSession);
    rerender(<MemoryRouter><InvestorHubPage /></MemoryRouter>);
    authMocks.signOut.mockImplementationOnce(async () => {
      authMocks.useSession.mockReturnValue(signedOutSession);
      return { data: {}, error: null };
    });

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    const signInForm = await screen.findByRole("form", { name: "Sign in form" });
    expect(within(signInForm).getByLabelText("Email")).toHaveValue("");
    expect(within(signInForm).getByLabelText("Password")).toHaveValue("");
    expect(within(signInForm).queryByLabelText("Name")).not.toBeInTheDocument();
  });

  it("surfaces Better Auth errors without exposing internals", async () => {
    authMocks.signInEmail.mockResolvedValue({ data: null, error: { message: "Invalid email or password" } });
    renderHub();
    const form = screen.getByRole("form", { name: "Sign in form" });

    fireEvent.change(within(form).getByLabelText("Email"), { target: { value: "person@example.com" } });
    fireEvent.change(within(form).getByLabelText("Password"), { target: { value: "wrongpass" } });
    fireEvent.click(within(form).getByRole("button", { name: "Sign in" }));

    expect(await within(form).findByRole("alert")).toHaveTextContent("Invalid email or password");
    expect(authMocks.refetch).not.toHaveBeenCalled();
  });

  it("returns a signed-in user to their selected AI Analysis stock", async () => {
    function LocationView() {
      return <output aria-label="Current route">{useLocation().pathname}{useLocation().search}</output>;
    }

    render(
      <MemoryRouter initialEntries={[{ pathname: "/account", state: { returnTo: "/ai-analysis?symbol=NVDA" } }]}>
        <Routes>
          <Route path="*" element={<><InvestorHubPage /><LocationView /></>} />
        </Routes>
      </MemoryRouter>,
    );
    const form = screen.getByRole("form", { name: "Sign in form" });
    fireEvent.change(within(form).getByLabelText("Email"), { target: { value: "person@example.com" } });
    fireEvent.change(within(form).getByLabelText("Password"), { target: { value: "password123" } });
    fireEvent.click(within(form).getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(screen.getByLabelText("Current route")).toHaveTextContent("/ai-analysis?symbol=NVDA"));
  });

  it("never honors a non-allowlisted returnTo after sign-in", async () => {
    function LocationView() {
      return <output aria-label="Current route">{useLocation().pathname}{useLocation().search}</output>;
    }

    for (const malicious of ["//evil.example", "https://evil.example", "/ai-analysis-evil"]) {
      const { unmount } = render(
        <MemoryRouter initialEntries={[{ pathname: "/account", state: { returnTo: malicious } }]}>
          <Routes>
            <Route path="*" element={<><InvestorHubPage /><LocationView /></>} />
          </Routes>
        </MemoryRouter>,
      );
      const form = screen.getByRole("form", { name: "Sign in form" });
      fireEvent.change(within(form).getByLabelText("Email"), { target: { value: "person@example.com" } });
      fireEvent.change(within(form).getByLabelText("Password"), { target: { value: "password123" } });
      fireEvent.click(within(form).getByRole("button", { name: "Sign in" }));

      await waitFor(() => expect(screen.getByLabelText("Current route")).toHaveTextContent("/account"));
      expect(screen.getByLabelText("Current route")).not.toHaveTextContent("evil");
      expect(screen.getByLabelText("Current route")).not.toHaveTextContent("https://");
      unmount();
    }
  });
});
