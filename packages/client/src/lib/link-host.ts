// Host is always re-derived from the URL at render time -- never stored or
// passed through from a registrant-supplied string (design doc §3.3/§7).
// `URL`'s IDNA normalization also closes the homograph-domain path as a side
// effect of parsing: a confusable Unicode host renders in its Punycode
// (`xn--...`) form.
export function linkHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
