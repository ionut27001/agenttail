'use strict';

/**
 * Provider problems of a dsh session: out of credit, rate limits, timeouts and
 * missing credentials. dsh logs them only inside `assistant/attempt` failures,
 * `llm/retry` and the error of `turn/end`, so a failed agent looks as if it
 * just stopped. A problem is projected with a fixed vocabulary, never the
 * provider's message text (which can carry account details):
 *
 *   kind      quota | rate-limit | timeout | auth | provider-error
 *   status    the HTTP status when the log has one, else null
 *   attempts  which attempt this was when the log counts them, else null
 *   provider  the route's name when it is a plain token, else null
 */

const KINDS = ['quota', 'rate-limit', 'timeout', 'auth', 'provider-error'];

const finiteInt = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n < 1e6 ? n : null;
};

/** The message is only read to classify, never kept. */
function kindOf({ code, status, message }) {
  const c = String(code ?? '').toUpperCase();
  if (/QUOTA|INSUFFICIENT|BALANCE|BILLING|CREDIT/.test(c) || status === 402) return 'quota';
  if (/RATE/.test(c) || status === 429) return 'rate-limit';
  // Provider codes (TIMEOUT, DEADLINE_EXCEEDED) and Node's (ETIMEDOUT, ESOCKETTIMEDOUT).
  if (/TIME_?OUT|TIMED_?OUT|DEADLINE/.test(c) || status === 408 || status === 504) return 'timeout';
  if (/CREDENTIAL|UNAUTHORI|^AUTH|API_KEY|FORBIDDEN|SIGN_?IN/.test(c) || status === 401 || status === 403) return 'auth';
  if (/insufficient balance/i.test(String(message ?? ''))) return 'quota';
  return 'provider-error';
}

/** A route name safe to show: a plain token, never free text. */
const plainName = (value) => (typeof value === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(value) ? value : null);

function make(failure, { attempts = null, provider = null } = {}) {
  const f = failure && typeof failure === 'object' ? failure : { message: failure };
  const status = finiteInt(f.status ?? f.statusCode);
  return {
    kind: kindOf({ code: f.code, status, message: f.message }),
    status: status >= 100 && status <= 599 ? status : null,
    attempts: finiteInt(attempts),
    provider: plainName(provider),
  };
}

/** The first failure in an attempt's stream chunks, if any. */
function attemptFailure(data) {
  for (const item of Array.isArray(data.stream) ? data.stream : []) {
    const failure = item && item.chunk && item.chunk.reason && item.chunk.reason.failure;
    if (failure) return failure;
  }
  return null;
}

/**
 * The problem a raw log event reports, or null. `route` is the provider and
 * model the request last announced. Field names of `llm/retry` are read
 * defensively: only a retry that names a failure or a retry count counts.
 */
function fromEvent(ev, route = null, previous = null) {
  const d = (ev && ev.data) || {};
  const provider = typeof d.provider === 'string' ? d.provider : route && route.provider;
  switch (ev && ev.type) {
    case 'assistant/attempt': {
      const failure = attemptFailure(d);
      return failure ? make(failure, { attempts: d.attempt ?? d.attemptNumber, provider }) : null;
    }
    case 'llm/retry': {
      const failure = d.failure ?? d.error ?? d.reason?.failure ?? (d.code || d.status ? d : null);
      const attempts = d.attempt ?? d.retry ?? d.retryNumber ?? d.n ?? d.count;
      if (failure) return make(failure, { attempts, provider });
      if (finiteInt(attempts) === null) return null;
      // A retry that names no failure retries the one just before it.
      const recent = previous && Math.abs((ev.time || 0) - (previous.since || 0)) <= 60_000 ? previous : {};
      return { kind: recent.kind || 'provider-error', status: recent.status ?? null, attempts: finiteInt(attempts), provider: plainName(provider) };
    }
    case 'turn/end': {
      const reason = d.reason && typeof d.reason === 'object' ? d.reason : {};
      const error = reason.error ?? d.error ?? (reason.kind === 'error' ? reason : null);
      return error ? make(error, { provider }) : null;
    }
    default:
      return null;
  }
}

/**
 * The latest unresolved problem of a session after one more log event: a new
 * problem replaces it, a successful reply (one that cost tokens) or a new turn
 * clears it. `current` is `{ ...problem, since, turn }` or null.
 */
function next(current, ev, route = null) {
  const found = fromEvent(ev, route, current);
  if (found) return { ...found, since: ev.time || 0, turn: Number.isInteger(ev.data && ev.data.turn) ? ev.data.turn : null };
  if (!current || !ev) return current;
  if (ev.type === 'turn/start') return null;
  if (ev.type === 'assistant/message' && ev.data && ev.data.usage) return null;
  return current;
}

/**
 * A failed attempt, its retry and the turn that finally gave up are one
 * failure told three times: show the repeat only when it adds an attempt count.
 */
function repeats(previous, problem) {
  if (!previous || !problem) return false;
  if (previous.kind !== problem.kind || previous.status !== problem.status) return false;
  if (previous.turn != null && problem.turn != null && previous.turn !== problem.turn) return false;
  if (Math.abs((problem.time || 0) - (previous.time || 0)) > 10_000) return false;
  return problem.attempts === null || problem.attempts === previous.attempts;
}

/** The shape sent to the page: fixed vocabulary only. */
function forPage(problem) {
  if (!problem || !KINDS.includes(problem.kind)) return null;
  return {
    kind: problem.kind,
    status: problem.status ?? null,
    attempts: problem.attempts ?? null,
    provider: problem.provider ?? null,
    since: problem.since || 0,
  };
}

module.exports = { KINDS, kindOf, fromEvent, next, repeats, forPage };
