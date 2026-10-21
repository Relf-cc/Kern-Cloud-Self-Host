// Which accounts manage an instance's workspace keys.
//
// Kept apart from routes/owner.ts, which is middleware and pulls in
// configuration and a database. The rule is a comparison between an address
// and a list, so it lives here where it can be read and tested on its own.
//
// Matching is case-insensitive and ignores surrounding whitespace, because
// ADMIN_EMAILS is typed by hand into a .env file. It is otherwise exact: no
// wildcards, no domain matching. "Everyone at this company may mint keys" is
// not a thing anybody should be able to configure by accident.

export function isListed(email: string | null | undefined, list: readonly string[]): boolean {
  if (!email) return false;
  const want = email.trim().toLowerCase();
  if (!want) return false;
  return list.some((entry) => entry.trim().toLowerCase() === want);
}
