# Authentik Setup

DeepLabel delegates authentication to Authentik via standard OIDC. The full
stack (server, worker, Postgres, Redis) runs from `compose.authentik.yml`.

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

The auth service calls Authentik itself too - for the discovery document, the signing
keys, the token and user info, and invitations - at `OIDC_ISSUER`'s address. When that
address cannot be reached from inside the auth container (behind `tailscale serve`, whose
listeners containers cannot connect to since Tailscale 1.104), set `OIDC_INTERNAL_URL` to
Authentik on the Docker network, e.g. `http://deeplabel-authentik:9000`. Browsers keep
using `OIDC_ISSUER`; the auth service's own calls go to the internal address with the
public host in the headers, so Authentik still answers with its public URLs.

## 2. Create the OIDC provider and application

In the admin UI (`http://<host>:9000`, log in as `akadmin`):

1. *Applications → Providers → Create*: **OAuth2/OpenID Provider**
   - Authorization flow: implicit consent
   - Client type: Confidential
   - Redirect URI (strict): `http://<app-host>:<port>/api/auth/callback`
   - Subject mode: **based on the user's username** - the app stores this as
     the stable user id, so keep it consistent
   - Signing key: authentik self-signed certificate
2. *Applications → Applications → Create*: name `DeepLabel`, slug
   `deeplabel`, pick the provider.
3. Copy client ID and secret into `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET`;
   set `OIDC_ISSUER=http://<host>:9000/application/o/deeplabel/`.

Use an address that both the auth container and the users' browsers can reach
(an IP or resolvable hostname - not `localhost` unless everything runs on the
user's machine).

## 3. Where Authentik sends people who arrive without an app

Set two things, or self-registered users are refused by Authentik itself:

1. On the application: **Launch URL** = the app's own address, e.g.
   `http://<app-host>:<port>`.
2. *System → Brands → <your brand>*: **Default application** = `DeepLabel`.

Authentik gives self-registered users the `external` type, and an external user
who reaches the Authentik interface rather than an application is redirected to
the brand's default application. With no default application there is nowhere to
redirect them to, so they get "Request has been denied. Interface can only be
accessed by internal users." instead - on the bare Authentik address, on a
bookmarked login page, or after any login that carried no application with it.
Making such users `internal` would also silence it and is the wrong fix: it hands
app-only users the Authentik interface.

Both live in the database, not in `.env`, so a rebuilt Authentik loses them.
Without the admin UI they can be set through
`docker exec <authentik-container> ak shell`:

```python
from authentik.core.models import Application
from authentik.brands.models import Brand
app = Application.objects.get(slug="deeplabel")
app.meta_launch_url = "http://<app-host>:<port>"
app.save(update_fields=["meta_launch_url"])
brand = Brand.objects.get(default=True)
brand.default_application = app
brand.save(update_fields=["default_application"])
```

## 4. First admin

Set `INITIAL_ADMIN_SUBJECT` in `.env` to your Authentik username. The first
login with that username is granted the admin role in the app.

## 5. Roles and what they allow

A role is a name for a set of capabilities, and an admin can make an exception per
person on the app's Admin page. The set is resolved by the auth service and travels to
the backend as `X-Auth-Caps`, which the frontend's nginx forwards beside `X-Auth-User`
and `X-Auth-Role`. A gateway that does not forward that header leaves the backend seeing
no capabilities, and everything a plain role does not already allow is refused - so a
custom gateway in front of this one has to pass it through as well. The older
`X-Auth-Train-Local` and `X-Auth-Train-Cluster` headers are still sent, derived from the
same set, and the backend reads them only when `X-Auth-Caps` is missing altogether.

## 6. Self-registration (optional)

Authentik ships an example enrollment flow. Create a blueprint instance for
`example/flows-enrollment-2-stage.yaml`, apply it, then link the resulting
flow as the enrollment flow of the `default-authentication-identification`
stage. The login page then offers "Sign up"; self-registered users start with
the `member` role.

To turn it off again, clear that same field - the flow itself can stay, so
enabling it later is one edit rather than a re-import:

```
docker exec -i deeplabel-authentik ak shell <<'PY'
from authentik.stages.identification.models import IdentificationStage
for stage in IdentificationStage.objects.exclude(enrollment_flow=None):
    stage.enrollment_flow = None
    stage.save(update_fields=['enrollment_flow'])
PY
```

Confirm against the running service rather than the field: the login flow's
first challenge carries no `enroll_url` once it is off.

```
curl -s "$AUTHENTIK_URL/api/v3/flows/executor/default-authentication-flow/?query=" | grep -c enroll_url
```

This lives in the database, not in `.env`, so a rebuilt Authentik comes back
with whatever the blueprint says. Worth checking whenever the instance is
reachable from outside the tailnet.

## 7. Letting a new user set their own password

Authentik needs no mail server for this. A recovery flow lets the admin hand out
a link the user opens to choose a password, after which they log in with their
email and that password. Create it once, reusing the stages of the stock
password-change flow, and make it the brand's recovery flow:

```
docker exec -i deeplabel-authentik ak shell <<'PY'
from authentik.flows.models import Flow, FlowStageBinding, FlowDesignation, FlowAuthenticationRequirement
from authentik.brands.models import Brand
from authentik.stages.prompt.models import PromptStage
from authentik.stages.user_write.models import UserWriteStage
from authentik.stages.user_login.models import UserLoginStage
flow, _ = Flow.objects.update_or_create(slug="deeplabel-recovery", defaults=dict(
    name="Set your password", title="Set your DeepLabel password",
    designation=FlowDesignation.RECOVERY,
    authentication=FlowAuthenticationRequirement.NONE))
stages = [PromptStage.objects.get(name="default-password-change-prompt"),
          UserWriteStage.objects.get(name="default-password-change-write"),
          UserLoginStage.objects.get(name="default-authentication-login")]
for order, stage in enumerate(stages):
    FlowStageBinding.objects.update_or_create(target=flow, stage=stage, defaults=dict(order=order * 10))
brand = Brand.objects.get(default=True)
brand.flow_recovery = flow
brand.save(update_fields=["flow_recovery"])
PY
```

Then per user: *Directory → Users → <user> → Create recovery link*, and send the
link yourself. The link carries the host the admin page was opened on, so open
it on the address the user can reach (the public one, if they are outside the
tailnet). The link is single-use and expires.

This lives in the database, not in `.env`, so a rebuilt Authentik loses it.

## 8. Inviting from the Admin page (optional)

With `AUTHENTIK_API_TOKEN` set, the Admin page gets an *Invite someone* form that does
the previous section without opening Authentik: it creates the account (or finds it by email) and
shows the recovery link for the admin to send. It needs the recovery flow from
the previous section, and refuses accounts that are not `external` or are superusers, since a link
sets the password of whatever account it is for.

The token belongs to a service account that may only see and add users and make
recovery links, so a leaked token cannot touch flows, providers or admins. This
creates it and writes the token into `.env` without printing it:

```
docker exec -i deeplabel-authentik ak shell <<'PY' 2>/dev/null | grep '^AUTHENTIK_API_TOKEN=' >> .env
from authentik.core.models import Token, TokenIntents, User, UserTypes
from authentik.rbac.models import Role
role, _ = Role.objects.get_or_create(name="deeplabel-inviter")
role.assign_perms(["authentik_core.view_user", "authentik_core.add_user",
                   "authentik_core.reset_user_password"])
account, _ = User.objects.get_or_create(username="deeplabel-inviter", defaults=dict(
    name="DeepLabel invitations", type=UserTypes.SERVICE_ACCOUNT, path="service-accounts"))
account.set_unusable_password()
account.save()
account.roles.add(role)
token, _ = Token.objects.get_or_create(identifier="deeplabel-inviter", defaults=dict(
    user=account, intent=TokenIntents.INTENT_API, expiring=False))
print(f"AUTHENTIK_API_TOKEN={token.key}")
PY
```

Then recreate `auth`. The auth service calls Authentik at the host in `OIDC_ISSUER`,
and Authentik writes that host into the link, so the link reaches whoever can log in.

## 9. Branding (optional)

Under *System → Brands*, set the branding title (e.g. `DeepLabel`) and
point the logo/favicon at the app's own icon, e.g.
`http://<app-host>:<port>/favicon.svg`.
