// Stand-in for the host's `customer_site/useRemoteParams`.
export function useRemoteParams(): Record<string, string | undefined> {
  return { agentId: "mock-agent" };
}
