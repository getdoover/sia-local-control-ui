// Module-federation remote modules provided by the host at runtime (the
// customer site in the cloud, the device agent's compatibility container on
// the Doovit). They have no published types, so declare them loosely here.
declare module "customer_site/RemoteComponentWrapper" {
  import type { ReactNode } from "react";
  const RemoteComponentWrapper: (props: { children: ReactNode }) => JSX.Element;
  export default RemoteComponentWrapper;
}

declare module "customer_site/useRemoteParams" {
  export function useRemoteParams(): Record<string, string | undefined>;
}

declare module "*.css";

// Assets forced to inline data URIs via the `?inline` query suffix: the
// single-file bundle ships only .js, so images must be embedded.
declare module "*.png?inline" {
  const dataUri: string;
  export default dataUri;
}

declare module "*.svg?inline" {
  const dataUri: string;
  export default dataUri;
}
