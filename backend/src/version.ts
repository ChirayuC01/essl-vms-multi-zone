declare const __VMS_VERSION__: string;

// Replaced from installer/vms-installer.iss by build-package.mjs. Source runs
// say "development" so package.json never becomes a second product version.
export const VMS_VERSION =
  typeof __VMS_VERSION__ === "string" ? __VMS_VERSION__ : "development";
