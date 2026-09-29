// Stand-in for the host's `customer_site/RemoteComponentWrapper`: the mock
// host already wraps the tree in DooverProvider + QueryClientProvider.
import type { ReactNode } from "react";

export default function RemoteComponentWrapper({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
