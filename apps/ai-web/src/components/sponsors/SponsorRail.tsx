import { ArrowUpRight, Building2 } from "lucide-react";
import { Link } from "react-router-dom";

export const sponsorSlots = [
  { id: "north", label: "Your company", detail: "Reach investors at the moment they research." },
  { id: "signal", label: "Your company", detail: "A considered place for a considered brand." },
  { id: "horizon", label: "Your company", detail: "Be part of the research room." },
  { id: "atlas", label: "Your company", detail: "Introduce your product to curious investors." },
  { id: "orbit", label: "Your company", detail: "A quiet, premium space for your message." },
  { id: "index", label: "Your company", detail: "Put your name beside better research." },
] as const;

export function SponsorRail() {
  return <aside className="sponsor-rail" aria-label="Sponsor placements">
    <div className="sponsor-rail-column sponsor-rail-left">{sponsorSlots.slice(0, 3).map(slot => <SponsorSlot key={slot.id} slot={slot} />)}</div>
    <div className="sponsor-rail-column sponsor-rail-right">{sponsorSlots.slice(3).map(slot => <SponsorSlot key={slot.id} slot={slot} />)}</div>
    <div className="sponsor-mobile-track">{sponsorSlots.map(slot => <SponsorSlot key={slot.id} slot={slot} />)}</div>
  </aside>;
}

function SponsorSlot({ slot }: { slot: (typeof sponsorSlots)[number] }) {
  return <Link className="sponsor-slot" to={`/sponsor/${slot.id}`} aria-label={`Sponsor: ${slot.label}`}><span className="sponsor-slot-top"><Building2 size={13} /> Sponsor</span><strong>{slot.label}</strong><small>{slot.detail}</small><ArrowUpRight size={14} className="sponsor-arrow" /></Link>;
}
