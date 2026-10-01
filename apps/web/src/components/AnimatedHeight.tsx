"use client";

import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";

const HEIGHT_TRANSITION_FALLBACK_MS = 250;

export function AnimatedHeight({ children }: { readonly children: ReactNode }) {
  const contentRef = useRef<HTMLDivElement>(null);

  const [heightState, setHeightState] = useState<{
    readonly height: number | null;
    readonly isClipping: boolean;
  }>({ height: null, isClipping: false });

  useEffect(() => {
    if (!heightState.isClipping) return;

    const timeoutId = window.setTimeout(() => {
      setHeightState((currentState) =>
        currentState.isClipping ? { ...currentState, isClipping: false } : currentState,
      );
    }, HEIGHT_TRANSITION_FALLBACK_MS);

    return () => window.clearTimeout(timeoutId);
  }, [heightState.height, heightState.isClipping]);

  useLayoutEffect(() => {
    const element = contentRef.current;

    if (!element) return;
    let firstFrameId: number | null = null;
    let secondFrameId: number | null = null;

    const updateHeight = () => {
      const nextHeight = Math.ceil(element.scrollHeight || element.getBoundingClientRect().height);
      setHeightState((currentState) => {
        if (currentState.height === nextHeight) return currentState;

        return {
          height: nextHeight,
          isClipping: currentState.height !== null,
        };
      });
    };

    const cancelPendingFrames = () => {
      if (firstFrameId !== null) {
        window.cancelAnimationFrame(firstFrameId);
        firstFrameId = null;
      }

      if (secondFrameId !== null) {
        window.cancelAnimationFrame(secondFrameId);
        secondFrameId = null;
      }
    };

    const updateHeightAfterPaint = () => {
      cancelPendingFrames();
      updateHeight();
      firstFrameId = window.requestAnimationFrame(() => {
        firstFrameId = null;
        updateHeight();
        secondFrameId = window.requestAnimationFrame(() => {
          secondFrameId = null;
          updateHeight();
        });
      });
    };

    updateHeightAfterPaint();
    const resizeObserver = new ResizeObserver(updateHeightAfterPaint);
    resizeObserver.observe(element);

    return () => {
      resizeObserver.disconnect();
      cancelPendingFrames();
    };
  }, []);

  return (
    <div
      data-slot="animated-height"
      className={cn(
        "transition-height duration-200 ease-out motion-reduce:transition-none",
        heightState.height !== null && "h-(--animated-height)",
        heightState.height !== null &&
          (heightState.isClipping ? "overflow-hidden" : "overflow-visible"),
      )}
      style={
        heightState.height === null ? undefined : { "--animated-height": `${heightState.height}px` }
      }
      onTransitionEnd={(event) => {
        if (event.target !== event.currentTarget || event.propertyName !== "height") return;
        setHeightState((currentState) =>
          currentState.isClipping ? { ...currentState, isClipping: false } : currentState,
        );
      }}
    >
      <div ref={contentRef}>{children}</div>
    </div>
  );
}
