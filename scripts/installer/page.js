// Capture once, erase immediately, and never persist or display the capability.
let bootstrapToken = location.hash.slice(1);
history.replaceState(null, '', location.pathname);

const status = document.getElementById('status');
const cancel = document.getElementById('cancel');
let csrfToken = '';
function message(text) {
  status.textContent = text;
}
async function request(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
    headers: body === undefined ? {} : {
      'Content-Type': 'application/json',
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 401) throw new Error('unauthorized');
  if (!response.ok) throw new Error('response');
  return response.json();
}
function failure(error, cancelling = false) {
  cancel.disabled = true;
  csrfToken = '';
  if (error.message === 'unauthorized') {
    message('Setup link invalid, already used or expired. Reopen setup from the trusted host.');
  } else if (error instanceof TypeError || error.name === 'TimeoutError') {
    message(cancelling
      ? 'Connection lost. Cancellation could not be confirmed. Reopen setup from the trusted host.'
      : 'Cannot reach the local setup service. Reopen setup from the trusted host.');
  } else {
    message(cancelling
      ? 'Cancellation could not be confirmed. Reopen setup from the trusted host.'
      : 'The local setup service returned an unexpected response. Reopen setup from the trusted host.');
  }
}
function snapshot(value) {
  if (value.installationAvailable !== false || !['idle', 'cancelled'].includes(value.state)) {
    throw new Error('response');
  }
  cancel.disabled = value.state === 'cancelled';
  message(value.state === 'cancelled'
    ? 'Setup session cancelled. Gentle Dot has not been shut down. You can close this tab.'
    : 'Session connected. Installation is unavailable; no package checks have run.');
}
cancel.addEventListener('click', async () => {
  cancel.disabled = true;
  message('Cancelling setup session…');
  try {
    snapshot(await request('/api/cancel', {}));
    csrfToken = '';
  } catch (error) { failure(error, true); }
});
async function connect() {
  if (!bootstrapToken) {
    message('No setup link provided. Open setup from the trusted host; reloading this page cannot start a session.');
    return;
  }
  if (!/^[a-f0-9]{64}$/.test(bootstrapToken)) {
    bootstrapToken = '';
    message('Invalid setup link. Reopen setup from the trusted host.');
    return;
  }
  try {
    // Clear the local copy before awaiting the exchange; no retries or polling.
    const pending = request('/api/session', { bootstrapToken });
    bootstrapToken = '';
    const session = await pending;
    if (!/^[a-f0-9]{64}$/.test(session.csrfToken)) throw new Error('response');
    csrfToken = session.csrfToken;
    snapshot(await request('/api/status'));
  } catch (error) { failure(error); }
}
connect();
