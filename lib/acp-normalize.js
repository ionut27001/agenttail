'use strict';

/**
 * Turns the loose shapes ACP agents send into the small, fixed objects the rest
 * of agenttail uses.  Nothing here talks to a process; it is all pure functions.
 */

/**
 * Pick the permission option for a decision, by its ACP `kind`, never by its
 * position: ACP does not fix the order of `options`, so the first one may well
 * be "always allow".
 *
 * Approve is `allow_once` and nothing else; with no such option the caller
 * refuses and the user can still reject.  Reject is `reject_once`, or
 * `reject_always` only when that is all the agent offers.
 */
function chooseOption(options, decision) {
  const list = Array.isArray(options) ? options : [];
  const byKind = (kind) => list.find((option) => option && option.kind === kind) || null;
  if (decision === 'approve') return byKind('allow_once');
  if (decision === 'reject') return byKind('reject_once') || byKind('reject_always');
  return null;
}

module.exports = { chooseOption };
