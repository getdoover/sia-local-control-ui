/**
 * Settings password: config `settings_password`, 4 to 16 letters and digits,
 * case-sensitive (blank = none). With one set, the LOCAL panel asks for it
 * on an on-screen keyboard before any settings change (target rate,
 * calibration factor and wizard, alarm thresholds and delays, sensor values,
 * VSD parameters), then stays unlocked until PASSWORD_UNLOCK_MS with no taps
 * (core/hmi-core.js pwdGate). Start, Stop and the fault resets never ask.
 * The cloud never asks: its users are signed in to Doover.
 *
 * A deterrent at the panel, not access control: the password is in the
 * install's config, readable by anyone who can see that config.
 */
import type { HostKind } from "./host.ts";

/** The password the screen on this host asks for, or null. */
export function settingsPasswordFor(password: string | null, host: HostKind): string | null {
  return host === "local" ? password : null;
}
