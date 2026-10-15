// Which pages may be goggled at all. Budget lives in db.ts; per-visitor rate limiting and
// bot filtering are Cloudflare dashboard rules, not code.

/** Site owners who asked to opt out (see README). Hostnames; subdomains are included. */
export const OPT_OUT: string[] = [];

const SENSITIVE_PATH = /(^|\/)(log-?in|sign-?in|sign-?up|register|auth|oauth2?|sso|account|accounts|password|checkout|cart|basket|payment|wp-admin|wp-login\.php)(\/|$|\.|-)/i;
const SENSITIVE_HOST = /(^|\.)(mail\.google\.com|accounts\.google\.com|outlook\.(live|office)\.com|mail\.yahoo\.com|login\.microsoftonline\.com|paypal\.com|stripe\.com)$|(^|[.-])bank([.-]|ing)/i;

/** Reason to refuse goggling this URL, or null. Used on every redirect hop. */
export function denyReason(url: URL, ownHost: string): string | null {
  const host = url.hostname.toLowerCase();
  if (host === ownHost || host.endsWith(".workers.dev")) return "own-host";
  if (OPT_OUT.some((h) => host === h || host.endsWith(`.${h}`))) return "opted-out";
  if (SENSITIVE_HOST.test(host)) return "sensitive-host";
  if (SENSITIVE_PATH.test(url.pathname)) return "sensitive-path";
  return null;
}
