#!/usr/bin/env node

const field = process.argv[2];
const knownFields = ["scheme", "ios-bundle-id", "android-package"];
if (process.argv.length !== 3 || !field || !knownFields.includes(field)) {
  console.error("Usage: app-identity.mjs <scheme|ios-bundle-id|android-package>");
  process.exit(2);
}
// Force the development variant before app.config.ts loads the repository environment.
process.env.APP_VARIANT = "development";
const { default: config } = await import("../../../../apps/mobile/app.config.ts");
const fields = {
  scheme: Array.isArray(config.scheme) ? config.scheme[0] : config.scheme,
  "ios-bundle-id": config.ios?.bundleIdentifier,
  "android-package": config.android?.package,
};
const value = fields[field];
if (!value || !/^[A-Za-z][A-Za-z0-9+.-]*$/.test(value)) {
  throw new Error(`Invalid development app identity: ${field}`);
}
console.log(value);
