"""Two properties the whole permission model rests on, asserted over every route rather
than route by route: a handler that takes an object's id checks who is asking, and a GET
never writes. Both are invisible in a diff - the next route added without a check is a
leak nobody sees - so they are tested structurally instead of by example.
"""
import ast
import pathlib

import pytest

ROUTES = pathlib.Path(__file__).resolve().parents[1] / 'app' / 'routes'

# The id in a path that names something belonging to a dataset. Everything reachable by
# guessing one of these has to be gated.
OWNED_IDS = ('{job_id}', '{page_id}', '{element_id}', '{line_id}', '{region_id}')

# Calls that establish the caller may touch this object. The four helpers in deps resolve
# up to the owning dataset; the rest are local to one router and do the same.
ACCESS_CHECKS = {
    'require_job_access', 'require_page_access', 'require_element_access',
    'require_line_access', 'require_region_access', 'can_access_job', 'require_job_owner',
    '_require_map_job', '_require_manager', '_own_reference', '_reference_scope',
    '_pipeline_or_404', '_owned_training', 'get_training', '_accessible_job',
    # The layout class routes' check: require_job_access, then a role that may edit.
    '_editing',
    # Shared with the bulk router so one dataset and a whole selection are gated by the
    # same code. It calls require_job_access and then the owner check; a route that
    # delegates to it is as gated as one that inlines them.
    'reocr_one',
}

# Routes that take an owned id, check neither, and have a reason. A new entry is a
# decision rather than an oversight.
ALLOWED_UNGATED: dict[tuple[str, str], str] = {}

MUTATIONS = ('INSERT INTO', 'UPDATE ', 'DELETE FROM')


def handlers():
    """Every routed function, with the source of its body."""
    for path in sorted(ROUTES.glob('*.py')):
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if not isinstance(node, ast.FunctionDef):
                continue
            for decorator in node.decorator_list:
                if not (isinstance(decorator, ast.Call)
                        and isinstance(decorator.func, ast.Attribute)
                        and isinstance(decorator.func.value, ast.Name)
                        and decorator.func.value.id == 'router'):
                    continue
                route = decorator.args[0].value if decorator.args else ''
                yield path.name, decorator.func.attr.upper(), route, node


def called_names(node: ast.FunctionDef) -> set[str]:
    names = set()
    for inner in ast.walk(node):
        if isinstance(inner, ast.Call):
            func = inner.func
            if isinstance(func, ast.Name):
                names.add(func.id)
            elif isinstance(func, ast.Attribute):
                names.add(func.attr)
    return names


def admin_only(node: ast.FunctionDef) -> bool:
    """Whether the signature admits admins and nobody else. An admin reaches every
    dataset (deps.can_access_job), so for them an object check decides nothing - which is
    not true the moment the same route also admits members."""
    for inner in ast.walk(node):
        if (isinstance(inner, ast.Call) and isinstance(inner.func, ast.Name)
                and inner.func.id == 'require_role'):
            roles = [arg.value for arg in inner.args if isinstance(arg, ast.Constant)]
            return roles == ['admin']
    return False


ALL = list(handlers())


def test_the_routers_were_actually_read():
    """A parser that quietly matched nothing would make both tests below vacuous."""
    assert len(ALL) > 100
    assert {method for _, method, _, _ in ALL} >= {'GET', 'POST', 'PATCH', 'DELETE'}


@pytest.mark.parametrize('module,method,route,node', ALL,
                         ids=[f'{m} {r}' for _, m, r, _ in ALL])
def test_a_route_naming_someone_elses_object_checks_who_is_asking(module, method, route, node):
    if not any(owned in route for owned in OWNED_IDS):
        return
    if (module, route) in ALLOWED_UNGATED:
        return
    assert called_names(node) & ACCESS_CHECKS or admin_only(node), (
        f'{method} {route} in {module} takes an object id and checks nobody. Call one of '
        f'{sorted(ACCESS_CHECKS)}, or restrict it to admins, or list it in ALLOWED_UNGATED '
        'with a reason.')


@pytest.mark.parametrize('module,method,route,node',
                         [h for h in ALL if h[1] == 'GET'],
                         ids=[f'{r}' for _, m, r, _ in ALL if m == 'GET'])
def test_a_get_never_writes(module, method, route, node):
    """Reading is what a viewer and a read-only token are allowed, and the gate that keeps
    them out is the HTTP method alone (app.main.auth_gate). A GET that wrote would hand
    both of them the write they were refused."""
    source = ast.unparse(node)
    writes = [w for w in MUTATIONS if w in source] + (['commit'] if 'commit()' in source else [])
    assert not writes, f'GET {route} in {module} writes ({writes}) - a viewer may call it.'
