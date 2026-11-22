import { type Account, type Cloud, CloudError } from './api';

/** How long a sign-in link stays valid on the website. */
const CONNECT_TTL_MS = 10 * 60_000;
const POLL_MS = 2000;

function base64url(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * A PKCE-style pair: the website only ever sees the challenge, and only this
 * device, holding the verifier, can redeem the approval for a key.
 */
export async function connectPair() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

export function connectUrl(base: string, challenge: string) {
  return `${base}/obsidian-connect?challenge=${encodeURIComponent(challenge)}`;
}

/** Polls until the user approves on the website; resolves with the plugin's key. */
export async function waitForApproval(
  cloud: Cloud,
  verifier: string,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
  signal?: AbortSignal
) {
  const until = Date.now() + CONNECT_TTL_MS;
  while (Date.now() < until) {
    if (signal?.aborted) throw new CloudError('Stopped', 499);
    const result = await cloud
      .json<{ status: 'pending' } | { status: 'approved'; token: string; account: Account['account'] }>(
        'POST',
        '/api/obsidian/token',
        { verifier }
      )
      .catch((error: unknown) => {
        if (error instanceof CloudError && (error.status === 0 || error.status === 429 || error.status >= 500))
          return { status: 'pending' as const };
        throw error;
      });
    if (result.status === 'approved') return result;
    await sleep(POLL_MS, signal);
  }
  throw new CloudError('The sign-in link expired. Try again.', 408);
}
