/** Mask obvious secrets before source leaves our server (FR-AIF security §2.2). */
export function redact(text: string): string {
  return text
    .replace(/(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{12,}|xox[baprs]-[A-Za-z0-9-]{10,})/g, '«REDACTED»')
    .replace(/(-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)/g, '«REDACTED-KEY»')
    .replace(/((?:password|secret|token|api[_-]?key)\s*[:=]\s*['"]?)([^\s'"]{6,})/gi, '$1«REDACTED»');
}

/** Files whose contents must never be sent to the model. */
export const REDACT_PATH = /(^|\/)(\.env(\..+)?|.*\.pem|.*\.key|.*\.p12|id_rsa)$/i;
