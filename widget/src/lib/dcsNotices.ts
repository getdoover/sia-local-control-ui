/**
 * DCS command pop-ups: whether this screen shows a card for each command the
 * DCS (the site's control system, over Modbus) sends the pump controller.
 *
 * Config `dcs_connected` (Boolean "DCS Connected", default off): many skids
 * have no DCS, so with it off (or unset, as on every existing install)
 * nothing new appears and no DCS tags are claimed. The HMI's own flag
 * decides, never the controller's `dcs_interface_enabled`.
 *
 * Shown on the local panel only, never in the cloud: the card is for the
 * operator standing at the skid, so a DCS command does not take them by
 * surprise. Same host signal as the alarm / sensor access gates
 * (lib/host.ts detectHost), failing safe to the cloud (no card).
 *
 * The wording and when a command is new are core/dcsCommand.js; the card is
 * the render core's (setDcsNotices).
 */
import type { HostKind } from "./host.ts";

export function dcsNoticesEnabled(dcsConnected: boolean, host: HostKind): boolean {
  return dcsConnected === true && host === "local";
}
