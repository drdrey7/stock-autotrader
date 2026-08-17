import { useEffect, useState } from "react";
import { type XPost } from "./data/xSurge";
import { fetchJson } from "./api-client";

type XApiPost = {
  id: string;
  author: string;
  text: string;
  created_at: string;
  url: string;
  symbol: string | null;
  company: string | null;
  price: string | null;
  change: string | null;
};

type XResponse = { posts?: XApiPost[]; count?: number };

const X_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const X_CACHE_KEY = "morning-briefing-x-post-cache-v1";

const relativeTime = (iso: string): string => {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "recent";
  const minutes = Math.max(0, Math.floor((Date.now() - then) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours ? `${days}d ${remainingHours}h` : `${days}d`;
};

function isWithinXCacheWindow(createdAt: string): boolean {
  const timestamp = Date.parse(createdAt);
  const ageMs = Date.now() - timestamp;
  return Number.isFinite(timestamp) && ageMs >= -5 * 60_000 && ageMs <= X_CACHE_MAX_AGE_MS;
}

function xPostsFromApi(posts: XApiPost[]): XPost[] {
  return [...posts]
    .filter((post) => isWithinXCacheWindow(post.created_at))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .map((post) => ({
      category: "Markets",
      name: post.company || post.author.replace(/^@/, ""),
      handle: post.author,
      time: relativeTime(post.created_at),
      createdAt: post.created_at,
      text: post.text,
      likes: "—",
      reposts: "—",
      replies: "—",
      color: "#176b47",
      url: post.url,
      source: "live",
    }));
}

function readStoredXPosts(): XPost[] {
  try {
    const raw = window.localStorage.getItem(X_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((post): post is XPost => (
      typeof post === "object" && post !== null
      && typeof (post as XPost).name === "string"
      && typeof (post as XPost).handle === "string"
      && typeof (post as XPost).text === "string"
      && typeof (post as XPost).createdAt === "string"
      && typeof (post as XPost).url === "string"
      && typeof (post as XPost).likes === "string"
      && typeof (post as XPost).reposts === "string"
      && typeof (post as XPost).replies === "string"
      && typeof (post as XPost).color === "string"
    ));
  } catch {
    return [];
  }
}

function writeStoredXPosts(posts: XPost[]): void {
  try {
    window.localStorage.setItem(X_CACHE_KEY, JSON.stringify(posts));
  } catch {
    // Storage full or unavailable: the in-memory list still works.
  }
}

function recentCachedPosts(posts: XPost[]): XPost[] {
  const byUrl = new Map<string, XPost>();
  for (const post of posts) {
    const existing = byUrl.get(post.url);
    if (!existing || Date.parse(post.createdAt) > Date.parse(existing.createdAt)) {
      byUrl.set(post.url, post);
    }
  }
  return [...byUrl.values()].filter((post) => isWithinXCacheWindow(post.createdAt));
}

export function useXPosts(): XPost[] {
  const [xPosts, setXPosts] = useState<XPost[]>(() => readStoredXPosts());

  useEffect(() => {
    let cancelled = false;
    let requestId = 0;

    const refresh = async () => {
      const currentRequest = ++requestId;
      const response = await fetchJson<XResponse>("/api/x/posts?limit=50");
      if (cancelled || currentRequest !== requestId) return;
      const liveX = response && Array.isArray(response.posts) ? xPostsFromApi(response.posts) : null;
      if (cancelled || currentRequest !== requestId) return;
      setXPosts((previous) => {
        const cached = recentCachedPosts([...readStoredXPosts(), ...previous]);
        const liveHandles = new Set((liveX ?? []).map((post) => post.handle.toLowerCase()));
        const retained = cached.filter((post) => !liveHandles.has(post.handle.toLowerCase()));
        const retimed = (posts: XPost[]) => posts.map((post) => ({ ...post, time: relativeTime(post.createdAt) }));
        const nextPosts = liveX === null
          ? retimed(cached)
          : [...liveX, ...retimed(retained)].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
        writeStoredXPosts(nextPosts);
        return nextPosts;
      });
    };

    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, 60_000);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return xPosts;
}
