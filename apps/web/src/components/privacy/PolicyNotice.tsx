import {
  AKERU_MARKETING_SITE_URL,
  AKERU_PRIVACY_POLICY_VERSION,
  AKERU_TERMS_VERSION,
  type ClientSettings,
} from "@t3tools/contracts/settings";

import { IS_PACKAGED_DESKTOP } from "~/branding";
import { isElectron } from "~/env";
import {
  useClientSettings,
  useClientSettingsHydrated,
  useUpdateClientSettings,
} from "~/hooks/useSettings";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

export function needsPolicyAcknowledgement(
  settings: Pick<ClientSettings, "reviewedPrivacyPolicyVersion" | "reviewedTermsVersion">,
): boolean {
  return (
    settings.reviewedPrivacyPolicyVersion !== AKERU_PRIVACY_POLICY_VERSION ||
    settings.reviewedTermsVersion !== AKERU_TERMS_VERSION
  );
}

export function shouldShowPolicyNotice(input: {
  readonly hydrated: boolean;
  readonly isDesktop: boolean;
  readonly isPackaged: boolean;
  readonly needsAcknowledgement: boolean;
}): boolean {
  return input.hydrated && input.isDesktop && input.isPackaged && input.needsAcknowledgement;
}

export function PolicyNotice() {
  const hydrated = useClientSettingsHydrated();
  const settings = useClientSettings();
  const updateSettings = useUpdateClientSettings();
  const open = shouldShowPolicyNotice({
    hydrated,
    isDesktop: isElectron,
    isPackaged: IS_PACKAGED_DESKTOP,
    needsAcknowledgement: needsPolicyAcknowledgement(settings),
  });

  return (
    <Dialog open={open}>
      <DialogPopup showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Review Akeru Bot policies</DialogTitle>
          <DialogDescription>
            Akeru Bot runs locally. Provider prompts and enabled online features still send data to
            their listed services.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3 text-sm text-muted-foreground">
          <p>
            Read the{" "}
            <a
              className="text-foreground underline underline-offset-4"
              href={`${AKERU_MARKETING_SITE_URL}/terms-of-service`}
              target="_blank"
              rel="noreferrer"
            >
              Terms of Use
            </a>{" "}
            and{" "}
            <a
              className="text-foreground underline underline-offset-4"
              href={`${AKERU_MARKETING_SITE_URL}/privacy-policy`}
              target="_blank"
              rel="noreferrer"
            >
              Privacy Policy
            </a>
            .
          </p>
        </DialogPanel>
        <DialogFooter>
          <Button
            onClick={() =>
              updateSettings({
                reviewedPrivacyPolicyVersion: AKERU_PRIVACY_POLICY_VERSION,
                reviewedTermsVersion: AKERU_TERMS_VERSION,
              })
            }
          >
            I reviewed these drafts
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
