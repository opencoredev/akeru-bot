/**
 * An Akeru Remote install runs either as the boot service under the service launcher or inside
 * the Remote container image. Desktop and plain `akeru serve` runs are not remote installs.
 */
export const isRemoteInstall = (input: {
  readonly launcherManaged: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
}) => input.launcherManaged || input.env.AKERU_REMOTE_CONTAINER === "1";
