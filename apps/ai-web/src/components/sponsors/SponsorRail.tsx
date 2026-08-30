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
    <div className="sponsor-mobile-track" aria-label="Sponsor placements scrolling">
      <div className="sponsor-mobile-group">
        {sponsorSlots.map(slot => <SponsorSlot key={slot.id} slot={slot} />)}
      </div>
      <div className="sponsor-mobile-group" aria-hidden="true">
        {sponsorSlots.map(slot => <SponsorSlot key={`${slot.id}-loop`} slot={slot} decorative />)}
      </div>
    </div>
  </aside>;
}

function SponsorSlot({ slot, decorative = false }: { slot: (typeof sponsorSlots)[number]; decorative?: boolean }) {
  return <Link className="sponsor-slot" to={`/sponsor/${slot.id}`} tabIndex={decorative ? -1 : undefined} aria-hidden={decorative || undefined} aria-label={decorative ? undefined : `Buy sponsor spot: ${slot.id}`}><span className="sponsor-slot-top"><Building2 size={13} /> Sponsor</span><strong>{slot.label}</strong><small>{slot.detail}</small><span className="sponsor-slot-cta">Buy this spot <ArrowUpRight size={12} /></span></Link>;
}
