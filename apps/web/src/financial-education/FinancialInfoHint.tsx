import { useEffect, useId, useRef, useState, type SyntheticEvent } from "react";
import { Info, X } from "lucide-react";
import { financialGlossary, type FinancialGlossaryTerm } from "./financial-glossary";
import "./financial-info-hint.css";

interface FinancialInfoHintProps {
  term: FinancialGlossaryTerm;
  className?: string;
}

export function FinancialInfoHint({ term, className = "" }: FinancialInfoHintProps) {
  const entry = financialGlossary[term];
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();
  const titleId = `${popoverId}-title`;

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const stopParentAction = (event: SyntheticEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <span ref={rootRef} className={`financial-info-hint ${className}`.trim()}>
      <button
        ref={triggerRef}
        type="button"
        className="financial-info-trigger"
        aria-label={`Learn what ${entry.title} means`}
        aria-expanded={open}
        aria-controls={popoverId}
        onClick={(event) => {
          stopParentAction(event);
          setOpen((value) => !value);
        }}
      >
        <Info size={12} strokeWidth={2} aria-hidden="true" />
      </button>

      {open && (
        <span
          id={popoverId}
          className="financial-info-popover"
          role="dialog"
          aria-labelledby={titleId}
          onClick={stopParentAction}
        >
          <span className="financial-info-popover-head">
            <strong id={titleId}>{entry.title}</strong>
            <button
              type="button"
              className="financial-info-close"
              aria-label={`Close ${entry.title} explanation`}
              onClick={(event) => {
                stopParentAction(event);
                setOpen(false);
                triggerRef.current?.focus();
              }}
            >
              <X size={13} strokeWidth={2} aria-hidden="true" />
            </button>
          </span>
          <span className="financial-info-description">{entry.shortDescription}</span>
        </span>
      )}
    </span>
  );
}

export default FinancialInfoHint;
