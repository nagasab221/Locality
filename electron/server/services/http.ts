// Outbound HTTP for all metadata/image services.
//
// By default this is Node's global fetch. The Electron shell swaps in
// Chromium's net.fetch at startup (see main.ts): unlike Node's fetch, the
// Chromium stack honors Windows system proxy settings — essential for users
// behind VPNs/proxies where direct connections to some CDNs are blocked.
type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

let impl: FetchLike = (input, init) => fetch(input, init);

export function setFetchImpl(f: FetchLike) {
  impl = f;
}

export const appFetch: FetchLike = (input, init) => impl(input, init);
