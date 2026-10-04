import { ipcRenderer } from "electron";
import { HUMAN_INPUT_CHANNEL, MOUSE_NAVIGATE_CHANNEL } from "./GuestProtocol.ts";

export function installGuestInputListeners() {
  const reportHumanPointerInput = (event: PointerEvent): void => {
    if (!event.isTrusted) return;
    ipcRenderer.send(HUMAN_INPUT_CHANNEL, {
      kind: "pointer",
      x: event.clientX,
      y: event.clientY,
      button: event.button,
    });
  };

  const reportHumanKeyInput = (event: KeyboardEvent): void => {
    if (!event.isTrusted) return;
    ipcRenderer.send(HUMAN_INPUT_CHANNEL, {
      kind: "key",
      key: event.key,
      code: event.code,
    });
  };

  window.addEventListener("pointerdown", reportHumanPointerInput, true);

  window.addEventListener("keydown", reportHumanKeyInput, true);

  // Mouse thumb buttons: `button === 3` is Back, `button === 4` is Forward.
  const MOUSE_BUTTON_BACK = 3;

  const MOUSE_BUTTON_FORWARD = 4;

  const navigationDirectionForButton = (button: number): "back" | "forward" | null => {
    if (button === MOUSE_BUTTON_BACK) return "back";

    if (button === MOUSE_BUTTON_FORWARD) return "forward";

    return null;
  };

  // Chromium routes thumb-button history navigation to the *focused* WebContents,
  // so hovering this guest without focusing it sends the host app's router back
  // instead of the preview. Suppress Chromium's default here and drive this tab's
  // history explicitly so the buttons always navigate the browser the pointer is
  // over, never the host app.
  const suppressNavigationButton = (event: MouseEvent): void => {
    if (!event.isTrusted || navigationDirectionForButton(event.button) === null) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  const requestNavigationForButton = (event: MouseEvent): void => {
    if (!event.isTrusted) return;
    const direction = navigationDirectionForButton(event.button);

    if (direction === null) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    ipcRenderer.send(MOUSE_NAVIGATE_CHANNEL, { direction });
  };

  window.addEventListener("mousedown", suppressNavigationButton, true);

  window.addEventListener("mouseup", requestNavigationForButton, true);

  window.addEventListener("auxclick", suppressNavigationButton, true);
}
