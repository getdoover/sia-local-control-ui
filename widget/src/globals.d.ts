declare module "customer_site/RemoteComponentWrapper" {
  import type { ReactNode } from "react";
  const RemoteComponentWrapper: (props: { children: ReactNode }) => JSX.Element;
  export default RemoteComponentWrapper;
}

declare module "customer_site/useRemoteParams" {
  export function useRemoteParams(): Record<string, string | undefined>;
}

declare module "*?inline" {
  const dataUrl: string;
  export default dataUrl;
}
