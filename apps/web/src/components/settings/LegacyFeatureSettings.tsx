import { ChevronRightIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { ensureLocalApi, readLocalApi } from "../../localApi";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Switch } from "../ui/switch";
import { SettingsRow, useSettingsSearchTargetId } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useI18n } from "../../i18n";

// The legacy rows sit behind the fold, so a settings-search jump has to
// expand the section before its target can mount and scroll.
const LEGACY_FEATURE_TARGET_IDS: ReadonlySet<string> = new Set([
  "legacy-token-streaming",
  "legacy-sidebar",
]);

/**
 * Retired features kept only for users who still depend on them. Collapsed by
 * default so they stay out of the everyday settings path; a settings-search
 * jump to one of the rows unfolds the section.
 */
export function LegacyFeaturesSection() {
  const { t } = useI18n();
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const [open, setOpen] = useState(false);
  const searchTargetId = useSettingsSearchTargetId();
  // Unfold once per search jump; tracking the handled id lets the user fold
  // the section back up without the still-set target immediately reopening it.
  const lastExpandedTargetRef = useRef<string | null>(null);
  useEffect(() => {
    if (searchTargetId === null) {
      // A handled jump clears the target; forgetting it here lets a later
      // jump to the same row expand the section again.
      lastExpandedTargetRef.current = null;

      return;
    }

    if (!LEGACY_FEATURE_TARGET_IDS.has(searchTargetId)) return;

    if (lastExpandedTargetRef.current === searchTargetId) return;
    lastExpandedTargetRef.current = searchTargetId;
    setOpen(true);
  }, [searchTargetId]);

  return (
    <section className="space-y-3">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger presentation="settings-section">
          <h2 className="text-lg font-semibold tracking-tight text-muted-foreground transition-colors group-hover:text-foreground">
            {t("Legacy features")}
          </h2>
          <ChevronRightIcon className="size-4 text-muted-foreground transition-transform duration-200 group-data-panel-open:rotate-90" />
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="relative space-y-1 overflow-visible pt-3 text-foreground">
            <SettingsRow
              {...searchableSetting("legacy-token-streaming", t)}
              description={t(
                "Paints assistant output token by token instead of in complete chunks. Not recommended: it is significantly slower, and long responses become harder to follow. Kept only for compatibility with the old behavior.",
              )}
              control={
                <Switch
                  checked={settings.enableLegacyTokenStreaming}
                  onCheckedChange={(checked) => {
                    if (!checked) {
                      updateSettings({ enableLegacyTokenStreaming: false });

                      return;
                    }

                    void (async () => {
                      const api = readLocalApi();

                      const confirmed = await (api ?? ensureLocalApi()).dialogs.confirm(
                        [
                          t("Turn on token-by-token output?"),
                          t(
                            "It is significantly slower than the default buffered output and hurts the reading experience. This switch exists only for backwards compatibility.",
                          ),
                        ].join("\n"),
                      );

                      if (confirmed) updateSettings({ enableLegacyTokenStreaming: true });
                    })();
                  }}
                  aria-label={t("Stream token by token (legacy)")}
                />
              }
            />
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </section>
  );
}
