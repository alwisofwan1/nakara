# Loopback is not trusted: every API request proves it is the operator

The web UI and API serve exactly one **Operator**, who proves it with the token cookie (or `Authorization: Bearer`) on every request, loopback included; only `/healthz` and `/metrics` stay open to loopback. Requests whose `Host` is not the configured host, a loopback name on the configured port, or the `publicUrl` host are refused before anything else, and `x-forwarded-host` from loopback is not trusted. Trusting loopback let any other Unix user on the VPS, and any web page through DNS rebinding while an SSH tunnel was open, create **Work Items** and rewrite agents without a token. The cost is opening `?token=` once per browser.

## Amendment: Cloudflare Access is a second proof

Behind Cloudflare Access, a request whose `Cf-Access-Jwt-Assertion` is signed by the team's Access keys, names our application's audience, has not expired and carries an Operator email (`NAKARA_ACCESS_*`) proves the Operator too. The signature is what makes it a proof: a process on the host can set the header but cannot sign it, so loopback stays untrusted. Unset, nothing changes.
