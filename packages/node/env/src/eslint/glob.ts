/** Suffix-anchored glob: `**`, `*` and `?` only. Matches anywhere on a normalised path. */
export function globToRegExp(glob: string): RegExp {
  let body = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (c === '*') {
      if (glob.charAt(i + 1) === '*') {
        if (glob.charAt(i + 2) === '/') {
          body += '(?:.*/)?';
          i += 2;
        } else {
          body += '.*';
          i += 1;
        }
      } else {
        body += '[^/]*';
      }
    } else if (c === '?') {
      body += '[^/]';
    } else {
      body += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`(?:^|/)${body}$`);
}

export function matchesAny(globs: readonly string[], filename: string): boolean {
  const normalised = filename.replace(/\\/g, '/');
  return globs.some(g => globToRegExp(g).test(normalised));
}
