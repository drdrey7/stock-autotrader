import { ArrowLeft, ArrowUpRight, Building2, CheckCircle2 } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { Shell } from "../components/layout/Shell";
import { sponsorSlots } from "../components/sponsors/SponsorRail";

export function SponsorPage() {
  const { slot } = useParams();
  const sponsor = sponsorSlots.find(item => item.id === slot) ?? sponsorSlots[0];
  return <Shell><main className="sponsor-page page"><Link className="back-link" to="/"><ArrowLeft size={15}/> Back to AI Analysis</Link><div className="sponsor-detail-grid"><div><div className="sponsor-detail-mark"><Building2 size={22}/></div><div className="section-kicker">Sponsor placement / {sponsor.id}</div><h1>Put your company<br/><em>inside the research.</em></h1><p className="sponsor-detail-copy">This is a dedicated sponsor page, ready for your company name, message, destination URL and campaign details.</p><div className="sponsor-detail-actions"><button className="primary-button" disabled>Reserve this placement <ArrowUpRight size={16}/></button><span>Checkout will connect to Stripe later.</span></div></div><aside className="sponsor-insert-card"><span className="section-kicker">Preview content</span><h2>{sponsor.label}</h2><p>{sponsor.detail}</p><div className="insert-fields"><div><small>Company URL</small><b>yourcompany.com</b></div><div><small>Campaign message</small><b>Your message here</b></div><div><small>Placement</small><b>AI Analysis / {sponsor.id}</b></div></div><div className="insert-status"><CheckCircle2 size={15}/> Ready for backend + Stripe integration</div></aside></div></main></Shell>;
}
