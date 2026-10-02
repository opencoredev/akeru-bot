import { type LegendListRef } from "@legendapp/list/react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

export function useModelPickerViewport(filteredItemKeys: ReadonlyArray<string>) {
  const [showTopScrollFade, setShowTopScrollFade] = useState(false);
  const [showBottomScrollFade, setShowBottomScrollFade] = useState(false);
  const modelListRef = useRef<LegendListRef | null>(null);

  const updateModelListScrollFades = useCallback(() => {
    const scrollElement = modelListRef.current?.getScrollableNode();

    if (!(scrollElement instanceof HTMLElement)) {
      return;
    }

    const maxScrollOffset = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
    setShowTopScrollFade(scrollElement.scrollTop > 1);
    setShowBottomScrollFade(maxScrollOffset - scrollElement.scrollTop > 1);
  }, []);

  useLayoutEffect(() => {
    setShowTopScrollFade(false);
    setShowBottomScrollFade(filteredItemKeys.length > 5);
    let nestedFrame = 0;

    const frame = window.requestAnimationFrame(() => {
      updateModelListScrollFades();
      nestedFrame = window.requestAnimationFrame(updateModelListScrollFades);
    });

    return () => {
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(nestedFrame);
    };
  }, [filteredItemKeys, updateModelListScrollFades]);

  return { modelListRef, showTopScrollFade, showBottomScrollFade, updateModelListScrollFades };
}
