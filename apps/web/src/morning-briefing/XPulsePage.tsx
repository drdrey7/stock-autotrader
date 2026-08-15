import { useState } from "react";
import { trackedXAccounts } from "./data/xSurge";
import { useMorningBriefingData } from "./MorningBriefingData";
import { Card, PostCard } from "./shared";

/** Lazy-loaded via React.lazy() in MorningBriefingApp.tsx — kept in its own file so it isn't in the initial bundle. */
export default function XPulsePage() {
  const { xPosts } = useMorningBriefingData();
  const [account, setAccount] = useState("All");
  const accountTabs = ["All", ...trackedXAccounts];
  const shown = [...(account === "All"
    ? xPosts
    : xPosts.filter((post) => post.handle.toLowerCase() === account.toLowerCase()))]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return <div className="page-content inner-page"><div className="page-heading"><span className="eyebrow">CURATED SOCIAL SIGNALS</span><h1>X Pulse</h1><p>The posts that matter from the accounts we track.</p></div><div className="filter-row" aria-label="Tracked X accounts">{accountTabs.map(item => <button key={item} aria-pressed={account === item} className={account === item ? "active" : ""} onClick={() => setAccount(item)}>{item}</button>)}</div><div className="surge-layout"><div className="feed">{shown.length ? shown.map(post => <Card key={post.url} className="post-shell"><PostCard post={post}/></Card>) : <Card><p className="empty-state">No recent posts.</p></Card>}</div></div></div>;
}
