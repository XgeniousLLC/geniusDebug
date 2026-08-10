import { REACT_ERROR_CODES } from './react-error-codes';

/**
 * Decode a production "Minified React error #NNN; visit
 * https://react.dev/errors/NNN?args[]=a&args[]=b ..." exception value into the
 * real developer-facing message from React's error-code table, substituting
 * the URL-encoded args[] into the template's %s slots — the same expansion
 * react.dev performs. Returns undefined when the value isn't a minified React
 * error or the code is unknown (caller keeps the original text).
 */
export function decodeReactError(value: string): string | undefined {
  const m = /^Minified React error #(\d+);.*?(https?:\/\/\S+)?/.exec(value);
  if (!m) return undefined;
  const code = m[1];
  const template = REACT_ERROR_CODES[code];
  if (!template) return undefined;

  // Pull the args[] out of the react.dev/errors URL embedded in the message.
  const args: string[] = [];
  const urlMatch = /https?:\/\/react\.dev\/errors\/\d+\?(\S+)/.exec(value);
  if (urlMatch) {
    for (const [k, v] of new URLSearchParams(urlMatch[1])) {
      if (k === 'args[]') args.push(v);
    }
  }

  let i = 0;
  const message = template.replace(/%s/g, () => args[i++] ?? '');
  return `React error #${code}: ${message.trim()}`;
}
