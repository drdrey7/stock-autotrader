import { Link } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import { Shell } from "../components/layout/Shell";

export function NotFoundPage() {
  return <Shell><main className="auth-shell"><div className="section-kicker">404 / Not found</div><h1>That page isn’t<br/><em>in the brief.</em></h1><p className="muted">The address may have moved. Return to the research room and start with a ticker.</p><Link className="primary-button" to="/" style={{marginTop:28}}>Back to the landing page <ArrowUpRight size={17}/></Link></main></Shell>;
}
