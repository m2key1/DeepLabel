# Authentik Setup

DeepLabel keeps its accounts in Authentik, and nobody ever sees Authentik: people sign
in on DeepLabel's own page, and the auth service runs Authentik's login flow for them
through its API, then completes a standard OIDC authorization with its own client. The
browser never holds an Authentik session. The full stack (server, worker, Postgres,
Redis) runs from `compose.authentik.yml`.

## 1. Configuration

Fill the `AUTHENTIK_*` section of your `.env` (see `.env.frontend.example`).
Generate the secrets:

```bash
openssl rand -base64 48   # AUTHENTIK_SECRET_KEY
openssl rand -base64 24   # AUTHENTIK_PG_PASSWORD
```

For the first boot, also set `AUTHENTIK_BOOTSTRAP_PASSWORD` (the `akadmin`
password) and `AUTHENTIK_BOOTSTRAP_TOKEN` (an API token, handy for scripted
setup). Remove both from `.env` after setup and revoke the token under
*Directory → Tokens* - it is a live admin credential.

```bash
docker compose -f compose.authentik.yml up -d
```

Every call to Authentik comes from the auth service - the login flow, the discovery
document, the token and user info, and invitations - at `OIDC_ISSUER`'s address. When that
address cannot be reached from inside the auth container (behind `tailscale serve`, whose
listeners containers cannot connect to since Tailscale 1.104), set `OIDC_INTERNAL_URL` to
Authentik on the Docker network, e.g. `http://deeplabel-authentik:9000`. The calls then go
to the internal address with the public host in the headers, so Authentik still answers
with its public URLs.

The login flow DeepLabel runs is the brand's authentication flow, and it answers the
identification and password stages. A flow with any other stage (a second factor, a
captcha, a consent) makes sign-in fail with "Signing in is not possible right now", and
the auth service logs which stage it met. Wrong passwords are throttled by the auth
service itself: 5 per account and 20 per address before a wait of a minute, doubling up
to 15 minutes.

## 2. Create the OIDC provider and application

In the admin UI (`http://<host>:9000`, log in as `akadmin`):

1. *Applications → Providers → Create*: **OAuth2/OpenID Provider**
   - Authorization flow: implicit consent
   - Client type: Confidential
   - Redirect URI (strict): `http://<app-host>:<port>/api/auth/callback` - the
     same value as `OIDC_REDIRECT_URI`. No browser is ever sent there; the auth service
     reads the authorization code off Authentik's redirect towards it.
   - Subject mode: **based on the user's username** - the app stores this as
     the stable user id, so keep it consistent
   - Signing key: authentik self-signed certificate
2. *Applications → Applications → Create*: name `DeepLabel`, slug
   `deeplabel`, pick the provider.
3. Copy client ID and secret into `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET`;
   set `OIDC_ISSUER=http://<host>:9000/application/o/deeplabel/`.

The auth container has to reach that address; browsers never need to.

## 3. Nobody visits Authentik

People sign in, sign up and set passwords on DeepLabel's own pages, so Authentik's
address never has to be reachable from a browser. Keep Authentik's own sign-up off (it
is off in a fresh install): it would make accounts behind DeepLabel's back. Section 6
says how to check.

## 4. First admin

Set `INITIAL_ADMIN_SUBJECT` in `.env` to your Authentik username. The first
sign-in with that username is granted the admin role in the app at once.

Anyone else signing in for the first time waits on a page that says so, until an admin
approves them on the Admin page with a role, or rejects them. Someone an admin invited
(section 6) is in at once, with the role of the invitation.

## 5. Roles and what they allow

A role is a name for a set of capabilities, and an admin can make an exception per
person on the app's Admin page. The set is resolved by the auth service and travels to
the backend as `X-Auth-Caps`, which the frontend's nginx forwards beside `X-Auth-User`
and `X-Auth-Role`. A gateway that does not forward that header leaves the backend seeing
no capabilities, and everything a plain role does not already allow is refused - so a
custom gateway in front of this one has to pass it through as well. The older
`X-Auth-Train-Local` and `X-Auth-Train-Cluster` headers are still sent, derived from the
same set, and the backend reads them only when `X-Auth-Caps` is missing altogether.

## 6. Managing accounts from DeepLabel (optional)

With `AUTHENTIK_API_TOKEN` set, DeepLabel manages accounts in Authentik itself:

- **Invite someone** on the Admin page creates the account (or finds it by email) with a
  role, and gives the admin a one-time DeepLabel link to send - nothing is emailed. The
  person sets a password on DeepLabel's page and is in at once.
- **Reset password** on a person's details gives the same kind of link for someone who
  forgot theirs. Their current password works until the link is used.
- **Change password** on everyone's own profile, without asking the old one; every other
  browser of theirs is signed out.
- **Sign-up** on the sign-in page, with `SELF_SIGN_UP=true`. A new account waits until an
  admin approves it; **Reject** switches it off here and in Authentik. One address may
  make three accounts an hour.

Every password is checked against Authentik's `default-password-change-password-policy`
before it is set. DeepLabel reads the policy and applies it itself, because Authentik's
policy-test endpoint fails for any caller but a superuser; a token without permission to
read the policy falls back to a minimum of 8 characters. The pages show a strength meter
held to the same policy, and a password too easy to guess is told so in one plain
sentence rather than with zxcvbn's advice. The same check runs at every sign-in: a
password that no longer meets the policy signs the person in to a page where they must
choose a new one first.
Only `external` accounts are touched: one that is `internal` or a superuser is managed in
Authentik, so a link can never hand over an operator's access.

The token belongs to a service account that may only see, add and change users, set
their passwords and read password policies - a leaked token cannot touch flows,
providers or admins. This creates it and writes the token into `.env` without printing it:

```
docker exec -i deeplabel-authentik ak shell <<'PY' 2>/dev/null | grep '^AUTHENTIK_API_TOKEN=' >> .env
from authentik.core.models import Token, TokenIntents, User, UserTypes
from authentik.rbac.models import Role
role, _ = Role.objects.get_or_create(name="deeplabel-accounts")
role.assign_perms(["authentik_core.view_user", "authentik_core.add_user", "authentik_core.change_user",
                   "authentik_core.reset_user_password",
                   "authentik_policies_password.view_passwordpolicy", "authentik_policies.view_policy"])
account, _ = User.objects.get_or_create(username="deeplabel-accounts", defaults=dict(
    name="DeepLabel accounts", type=UserTypes.SERVICE_ACCOUNT, path="service-accounts"))
account.set_unusable_password()
account.save()
account.roles.add(role)
token, _ = Token.objects.get_or_create(identifier="deeplabel-accounts", defaults=dict(
    user=account, intent=TokenIntents.INTENT_API, expiring=False))
print(f"AUTHENTIK_API_TOKEN={token.key}")
PY
```

Then recreate `auth`. Check that Authentik's own sign-up is off - the login flow's first
challenge carries no `enroll_url`:

```
curl -s "$AUTHENTIK_URL/api/v3/flows/executor/default-authentication-flow/?query=" | grep -c enroll_url
```

and turn it off if it is on:

```
docker exec -i deeplabel-authentik ak shell <<'PY'
from authentik.stages.identification.models import IdentificationStage
for stage in IdentificationStage.objects.exclude(enrollment_flow=None):
    stage.enrollment_flow = None
    stage.save(update_fields=['enrollment_flow'])
PY
```

## 7. Moving an existing deployment

For a deployment that signed people in on Authentik's pages before:

1. Check that the brand's authentication flow asks only for the identification and the
   password stage (*Flows → default-authentication-flow → Stage bindings*). Anything
   else - a second factor, a captcha - makes DeepLabel's sign-in fail and the auth
   service log the stage it met.
2. Keep the provider's redirect URI; it still has to match `OIDC_REDIRECT_URI`.
3. Replace the invitation token: run the script in section 6 and put the new token in
   `.env` in place of the old one. The old `deeplabel-inviter` account and role can be
   deleted in Authentik; recovery links it made still open Authentik's own page until they
   expire.
4. Remove `SESSION_SECRET` from `.env`; nothing reads it any more.
5. Set `SELF_SIGN_UP=true` if people should be able to sign up, then recreate `auth` and
   `frontend`.

Nobody is signed out by the move, and accounts DeepLabel already knows are left as they
are. Someone who has an Authentik account but never signed in to DeepLabel waits for
approval on their first sign-in - invite them instead to let them straight in. The
`deeplabel-recovery` flow, the application's Launch URL and the brand's default
application are no longer used and can stay.
