# Fun run registration

A registration site for fun runs and marathons. The organizer publishes races; runners sign up from the public page.

## Run it

```bash
node server.js
```

Open http://localhost:3000. Needs Node 18 or newer, nothing to install.

- **Runners** use the home page: pick a race, fill in the form, get a bib number.
- **Organizer** uses the "Organizer" link. The password is created on first start and saved in `data/admin-password.txt`. Edit that file to change it, then restart.

## Put it online

Any host that runs Node works. Set these environment variables:

| Variable | What it does |
| --- | --- |
| `ADMIN_PASSWORD` | Organizer password (use this instead of the file when hosting). |
| `DATA_DIR` | Folder where races and registrations are saved. **Point it at a persistent disk**, or registrations are lost when the host restarts. |
| `PORT` | Port to listen on (most hosts set this for you). |
| `TZ` | Your timezone, e.g. `Asia/Manila`, so the registration deadline closes at your midnight. |

Serve it over HTTPS so the organizer password and runner details are encrypted in transit.

## Files

- `server.js` — the server and all rules (deadlines, slot limits, organizer sign-in).
- `index.html` — every page of the site.
- `test.js` — `node test.js` checks the core flow.
- `data/` — your races, registrations, and password. Back this folder up. Never share it.
