import { ArrowDownIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useI18n } from "~/i18n";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { CONVERSATION_MEASURE_CLASS_NAME } from "./botConversationPresentation";
import {
  didScrollAwayFromEnd,
  isConversationAtEnd,
  reduceConversationFollowState,
  type ConversationFollowEvent,
  type ConversationFollowState,
  type ConversationScrollMetrics,
} from "./botConversationScroll.logic";

function readMetrics(viewport: HTMLElement): ConversationScrollMetrics {
  return {
    scrollTop: viewport.scrollTop,
    scrollHeight: viewport.scrollHeight,
    clientHeight: viewport.clientHeight,
  };
}

/**
 * Scrolls a chat and keeps it pinned to the newest content while the reader is at
 * the end. Scrolling up unpins it and reveals a jump-to-latest button. A change to
 * `followKey` (for example the id of the newest user message) re-pins it, so
 * sending a message always lands at the end.
 */
export function BotConversationScrollArea({
  children,
  followKey,
}: {
  readonly children: ReactNode;
  readonly followKey?: string | null | undefined;
}) {
  const { t } = useI18n();
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followStateRef = useRef<ConversationFollowState>({ followingEnd: true });
  const [isAtEnd, setIsAtEnd] = useState(true);

  const dispatch = (event: ConversationFollowEvent) => {
    followStateRef.current = reduceConversationFollowState(followStateRef.current, event);
  };

  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;

    let lastMetrics = readMetrics(viewport);
    const updateScrollState = () => {
      const metrics = readMetrics(viewport);
      const nextIsAtEnd = isConversationAtEnd(metrics);
      setIsAtEnd(nextIsAtEnd);
      dispatch({
        type: "scroll",
        isAtEnd: nextIsAtEnd,
        movedAway: didScrollAwayFromEnd(lastMetrics, metrics),
      });
      lastMetrics = metrics;
    };

    // Content growth and viewport resizes (composer growing, window resize) both
    // move the end. Re-pin before paint when the reader is following it.
    const followLayoutChange = () => {
      if (followStateRef.current.followingEnd) {
        viewport.scrollTop = viewport.scrollHeight;
      }
      updateScrollState();
    };

    viewport.scrollTop = viewport.scrollHeight;
    updateScrollState();
    const observer = new ResizeObserver(followLayoutChange);
    observer.observe(content);
    observer.observe(viewport);
    viewport.addEventListener("scroll", updateScrollState, { passive: true });

    return () => {
      observer.disconnect();
      viewport.removeEventListener("scroll", updateScrollState);
    };
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!followKey || !viewport) return;
    dispatch({ type: "scroll-to-end" });
    viewport.scrollTop = viewport.scrollHeight;
  }, [followKey]);

  const scrollToEnd = () => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    dispatch({ type: "scroll-to-end" });
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="bot-conversation-scroll-area">
      <div
        ref={viewportRef}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-6 pb-1 [scrollbar-gutter:stable_both-edges] sm:px-6"
        data-testid="bot-conversation-viewport"
        onWheel={(event) => {
          if (event.deltaY < 0) dispatch({ type: "user-navigation" });
        }}
      >
        <div ref={contentRef} className="flex min-h-full w-full flex-col">
          <div className={cn("mt-auto flex flex-col gap-1", CONVERSATION_MEASURE_CLASS_NAME)}>
            {children}
          </div>
        </div>
      </div>

      {/* A gutter outside the scrolling content, so the button never covers a message. */}
      <div className="flex h-9 shrink-0 items-center justify-center">
        {!isAtEnd ? (
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label={t("Scroll to latest message")}
            className="rounded-full text-muted-foreground shadow-xs hover:text-foreground"
            onClick={scrollToEnd}
          >
            <ArrowDownIcon className="size-4" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
