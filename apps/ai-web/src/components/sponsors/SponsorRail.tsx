import { ArrowUpRight, Building2 } from "lucide-react";
import { Link } from "react-router-dom";

export const sponsorSlots = [
  { id: "north", label: "Your brand here", detail: "Reach investors while they research." },
  { id: "signal", label: "Your brand here", detail: "Reach investors while they research." },
  { id: "horizon", label: "Your brand here", detail: "Reach investors while they research." },
  { id: "atlas", label: "Your brand here", detail: "Reach investors while they research." },
  { id: "orbit", label: "Your brand here", detail: "Reach investors while they research." },
  { id: "index", label: "Your brand here", detail: "Reach investors while they research." },
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
