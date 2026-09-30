/**
 * The composer that owns the active model picker registers itself here so the
 * command palette can open it without knowing which composer is mounted. The
 * chat composer publishes a full `ChatComposerHandle`; surfaces that only
 * change a model (the bot chat composer) publish just this.
 */
export interface ComposerModelPickerHandle {
  readonly openModelPicker: () => void;
}

let activeHandle: ComposerModelPickerHandle | null = null;

/** Returns a cleanup that only clears the registry when this handle is still the live one. */
export function registerComposerModelPicker(handle: ComposerModelPickerHandle): () => void {
  activeHandle = handle;
  return () => {
    if (activeHandle === handle) activeHandle = null;
  };
}

export function activeComposerModelPicker(): ComposerModelPickerHandle | null {
  return activeHandle;
}
