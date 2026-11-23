import os
import sys

import httpx

POLICY = 'deeplabel-needs-recovery-codes'
# Recovery codes come right after the code check, for anyone who has none yet.
NEEDS_RECOVERY_CODES = "return not ak_user_has_authenticator(request.context['pending_user'], 'static')"


def _api(client: httpx.Client, method: str, path: str, **kwargs):
    response = client.request(method, path, **kwargs)
    response.raise_for_status()
    return response.json() if response.content else None


def _stage(stages: list[dict], component: str) -> dict:
    return next(stage for stage in stages if stage['component'] == component)


def require(client: httpx.Client, flow_slug: str = 'default-authentication-flow') -> None:
    flow = _api(client, 'GET', '/api/v3/flows/instances/', params={'slug': flow_slug})['results'][0]
    stages = _api(client, 'GET', '/api/v3/stages/all/', params={'page_size': 200})['results']
    bindings = _api(client, 'GET', '/api/v3/flows/bindings/', params={'target': flow['pk']})['results']
    validate = next(b for b in bindings if b['stage_obj']['component'] == 'ak-stage-authenticator-validate-form')
    totp_setup = _stage(stages, 'ak-stage-authenticator-totp-form')
    static_setup = _stage(stages, 'ak-stage-authenticator-static-form')
    _api(client, 'PATCH', f"/api/v3/stages/authenticator/validate/{validate['stage']}/", json={
        'not_configured_action': 'configure', 'device_classes': ['totp', 'static'],
        'configuration_stages': [totp_setup['pk']]})
    static = next((b for b in bindings if b['stage'] == static_setup['pk']), None) or _api(
        client, 'POST', '/api/v3/flows/bindings/', json={
            'target': flow['pk'], 'stage': static_setup['pk'], 'order': validate['order'] + 1,
            # Judged when it is reached, after the code check has set up an app.
            'evaluate_on_plan': False, 're_evaluate_policies': True})
    policy = (_api(client, 'GET', '/api/v3/policies/expression/', params={'name': POLICY})['results'] or [None])[0] \
        or _api(client, 'POST', '/api/v3/policies/expression/', json={'name': POLICY, 'expression': NEEDS_RECOVERY_CODES})
    target = static['policybindingmodel_ptr_id']
    if not _api(client, 'GET', '/api/v3/policies/bindings/', params={'target': target})['results']:
        _api(client, 'POST', '/api/v3/policies/bindings/', json={'policy': policy['pk'], 'target': target, 'order': 0})


def relax(client: httpx.Client, flow_slug: str = 'default-authentication-flow') -> None:
    """Back to a second factor only for those who set one up: what a fresh Authentik does."""
    flow = _api(client, 'GET', '/api/v3/flows/instances/', params={'slug': flow_slug})['results'][0]
    bindings = _api(client, 'GET', '/api/v3/flows/bindings/', params={'target': flow['pk']})['results']
    for binding in bindings:
        component = binding['stage_obj']['component']
        if component == 'ak-stage-authenticator-validate-form':
            _api(client, 'PATCH', f"/api/v3/stages/authenticator/validate/{binding['stage']}/",
                 json={'not_configured_action': 'skip'})
        elif component == 'ak-stage-authenticator-static-form':
            _api(client, 'DELETE', f"/api/v3/flows/bindings/{binding['pk']}/")


def main() -> None:
    """Make a second factor part of signing in, on an Authentik set up as AUTHENTIK.md describes:

        AUTHENTIK_URL=http://127.0.0.1:9000 AUTHENTIK_ADMIN_TOKEN=... python -m app.second_factor_setup

    Every account then sets up an authenticator app and stores recovery codes at its next sign-in,
    and gives a code from one of them at every sign-in after; `--relax` undoes it. Run again, it
    changes nothing. It needs an admin's token: the service account may not edit flows."""
    url, token = os.environ.get('AUTHENTIK_URL', '').rstrip('/'), os.environ.get('AUTHENTIK_ADMIN_TOKEN', '')
    if not url or not token:
        sys.exit('set AUTHENTIK_URL and AUTHENTIK_ADMIN_TOKEN')
    with httpx.Client(base_url=url, headers={'Authorization': f'Bearer {token}'}, timeout=30) as client:
        (relax if sys.argv[1:] == ['--relax'] else require)(client)
    print('a second factor is ' + ('optional again' if sys.argv[1:] == ['--relax'] else 'required at sign-in'))


if __name__ == '__main__':
    main()
