# Security

Please report vulnerabilities privately through GitHub's
[private vulnerability reporting](../../security/advisories/new) for this repository, not
in a public issue. Do not include real tokens, VINs, cookies, database details or
listening history in reports.

## Design notes

- Neither service has a login of its own; both listen on 127.0.0.1 by default and are meant
  to sit behind a reverse proxy with authentication. Anyone who reaches the bilibili
  mirror uses the bilibili account logged in through it; anyone who reaches the lyrics
  service sees what the car is playing and can change the global lyric offset.
- The lyrics service holds TeslaMate's encryption key, which decrypts the stored Tesla
  token. Use a read-only database role (see README) and keep `.env` private.
- The mirror only talks to bilibili hosts (an allowlist), does not follow redirects, keeps
  bilibili's HttpOnly login cookies server-side, sends them only to bilibili hosts, and
  drops the login layer's cookies and headers before forwarding.
- Containers run as non-root users with a read-only root filesystem, no capabilities and
  `no-new-privileges`.
