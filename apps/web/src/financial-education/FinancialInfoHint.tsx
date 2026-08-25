import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { Lightbulb, X } from "lucide-react";
import { financialGlossary, type FinancialGlossaryTerm } from "./financial-glossary";
import "./financial-info-hint.css";

interface FinancialInfoHintProps {
  term: FinancialGlossaryTerm;
  className?: string;
}

interface PopoverPosition {
  left: number;
  top: number;
}

const POPOVER_GAP = 6;
const VIEWPORT_PADDING = 12;
const POPOVER_MAX_WIDTH = 260;

export function FinancialInfoHint({ term, className = "" }: FinancialInfoHintProps) {
  const entry = financialGlossary[term];
  const [open, setOpen] = useState(false);
  const [popoverPosition, setPopoverPosition] = useState<PopoverPosition | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLSpanElement>(null);
  const popoverId = useId();
  const titleId = `${popoverId}-title`;

  useLayoutEffect(() => {
    if (!open) return;

    const updatePosition = () => {
      const trigger = triggerRef.current;
      const popover = popoverRef.current;
      if (!trigger || !popover) return;

      const triggerRect = trigger.getBoundingClientRect();
      const popoverRect = popover.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
      const viewportHeight = window.innerHeight;
      const maxAvailableWidth = Math.max(0, viewportWidth - VIEWPORT_PADDING * 2);
      const popoverWidth = popoverRect.width || Math.min(POPOVER_MAX_WIDTH, maxAvailableWidth);
      const popoverHeight = popoverRect.height;

      const maxLeft = Math.max(VIEWPORT_PADDING, viewportWidth - VIEWPORT_PADDING - popoverWidth);
      const left = Math.min(Math.max(triggerRect.left, VIEWPORT_PADDING), maxLeft);

      const belowTop = triggerRect.bottom + POPOVER_GAP;
      const aboveTop = triggerRect.top - POPOVER_GAP - popoverHeight;
      let top = belowTop;

      if (popoverHeight > 0 && belowTop + popoverHeight > viewportHeight - VIEWPORT_PADDING) {
        if (aboveTop >= VIEWPORT_PADDING) {
          top = aboveTop;
        } else {
          top = Math.max(
            VIEWPORT_PADDING,
            Math.min(belowTop, viewportHeight - VIEWPORT_PADDING - popoverHeight),
          );
        }
      }

      setPopoverPosition({ left, top });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    popoverRef.current?.focus();

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !popoverRef.current?.contains(target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };

    document.addEventListener("pointerdown", onPointerDown);
    // Capture Escape before parent drawers/dialogs so the hint closes first.
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  const stopParentAction = (event: SyntheticEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const popoverStyle: CSSProperties = popoverPosition
    ? { left: popoverPosition.left, top: popoverPosition.top }
    : { left: VIEWPORT_PADDING, top: VIEWPORT_PADDING, visibility: "hidden" };

  const popover = open && typeof document !== "undefined"
    ? createPortal(
        <span
          ref={popoverRef}
          id={popoverId}
          className="financial-info-popover"
          role="dialog"
          aria-labelledby={titleId}
          tabIndex={-1}
          style={popoverStyle}
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
              <X size={12} strokeWidth={2} aria-hidden="true" />
            </button>
          </span>
          <span className="financial-info-description">{entry.shortDescription}</span>
          {entry.interpretation ? (
            <span className="financial-info-interpretation">
              <strong>Usually:</strong> {entry.interpretation}
            </span>
          ) : null}
        </span>,
        document.body,
      )
    : null;

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
          if (open) {
            setOpen(false);
          } else {
            setPopoverPosition(null);
            setOpen(true);
          }
        }}
      >
        <Lightbulb size={15} strokeWidth={2} aria-hidden="true" />
      </button>
      {popover}
    </span>
  );
}

export default FinancialInfoHint;
