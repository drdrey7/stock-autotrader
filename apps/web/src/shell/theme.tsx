/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Moon, Sun } from "lucide-react";

/**
 * Theme state for the application shell.
 *
 * The application styles its light/dark palettes off the `data-theme` attribute
 * on <html>, so the provider keeps that attribute, localStorage persistence
 * and the `theme-color` meta tag in one place — independent of any single page.
 */
export type ShellTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "how-are-the-markets-theme";
export const LEGACY_THEME_STORAGE_KEY = "morning-briefing-theme";

interface ThemeContextValue {
  theme: ShellTheme;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readInitialTheme(): ShellTheme {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored !== "light" && stored !== "dark") {
      stored = localStorage.getItem(LEGACY_THEME_STORAGE_KEY);
    }
  } catch {
    // Storage can be unavailable (private mode, stricter policies). The write
    // path is already guarded; the read must not be able to crash the app.
    stored = null;
  }
  if (stored === "light" || stored === "dark") return stored;

  // Product default: first-time visitors start in dark mode. An explicit user
  // choice is still persisted and always wins on later visits.
  return "dark";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ShellTheme>(readInitialTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Storage can be unavailable (private mode, tests); the in-page theme still works.
    }
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", theme === "dark" ? "#080d1a" : "#f7f9fc");
  }, [theme]);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, toggleTheme: () => setTheme((current) => (current === "light" ? "dark" : "light")) }),
    [theme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useShellTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useShellTheme must be used inside <ThemeProvider>");
  return context;
}

/** Icon-only toggle rendered in the shell chrome (sidebar + mobile top bar). */
export function ThemeToggle() {
  const { theme, toggleTheme } = useShellTheme();
  const next = theme === "light" ? "dark" : "light";
  return (
    <button
      type="button"
      className="shell-theme-toggle"
      onClick={toggleTheme}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
    >
      {theme === "light" ? <Moon size={16} aria-hidden="true" /> : <Sun size={16} aria-hidden="true" />}
    </button>
  );
}
