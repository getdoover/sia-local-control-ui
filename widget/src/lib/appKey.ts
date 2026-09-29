import { DEFAULT_APP_KEY } from "./assembleDashboardData.ts";

export interface UiRemoteComponent {
  /** This install's app key; its config block lives under it in deployment_config. */
  app_key?: string;
  /** In the local host this may be the widget channel `<app_key>_widget`. */
  name?: string;
}

/**
 * This install's app key in either host: the cloud supplies
 * `uiElement.app_key`; the local host may instead name the element after the
 * widget channel (`<app_key>_widget`) and carries `?app_key=` in the page URL
 * (the HMI Display Engine's default URL does).
 */
export function resolveAppKey(uiElement?: UiRemoteComponent, search?: string): string {
  if (uiElement?.app_key && !uiElement.app_key.startsWith("$")) return uiElement.app_key;
  const name = uiElement?.name;
  if (typeof name === "string" && name.endsWith("_widget") && name !== "sia_hmi_widget") {
    return name.slice(0, -"_widget".length);
  }
  if (search) {
    const fromUrl = new URLSearchParams(search).get("app_key");
    if (fromUrl) return fromUrl;
  }
  return DEFAULT_APP_KEY;
}

