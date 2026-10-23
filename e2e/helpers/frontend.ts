/** Where the app is served, through nginx and the auth service - the base a browser
 *  would use. Tests that sign in with a session cookie have to go through it rather than
 *  straight to the backend, and a second harness runs on a different port, so this is the
 *  one place the port is decided. */
export const FRONTEND = process.env.E2E_FRONTEND_URL ?? 'http://localhost:8090'
