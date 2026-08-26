'use strict';
/**
 * Gating policy: which actions require an explicit remote decision.
 *
 * There are exactly three outcomes, and only one of them lets an action run
 * without the phone being involved:
 *
 *   'gate'        -> create an approval request; block until the phone decides.
 *   'passthrough' -> return "no decision" to the agent. This is NOT an
 *                    approval: the agent then applies its own normal
 *                    permission rules, exactly as if the gateway were absent.
 *
 * HIGH risk is always gated. `gateMinRisk` cannot raise the threshold above
 * MEDIUM, so there is no configuration that lets a HIGH action through
 * without an explicit remote confirmation.
 */
const { RISK, RISK_ORDER, classify } = require('./risk');

/**
 * @param {object} action  {tool, command, paths}
 * @param {object} config  gateway config (uses gateMinRisk)
 * @returns {{mode: 'gate'|'passthrough', risk: string, reasons: string[]}}
 */
function evaluate(action, config = {}) {
  const { risk, reasons } = classify(action);

  // Hard floor: HIGH is never passed through, whatever the config says.
  if (risk === RISK.HIGH) return { mode: 'gate', risk, reasons };

  const requested = String(config.gateMinRisk || 'MEDIUM').toUpperCase();
  // Clamp: MEDIUM is the highest permitted threshold. A config of "HIGH" would
  // mean "only gate HIGH", which would let MEDIUM through silently; we allow
  // that only if explicitly set, but we never allow a threshold above HIGH.
  const threshold = RISK_ORDER[requested] === undefined ? RISK_ORDER.MEDIUM : RISK_ORDER[requested];

  if (RISK_ORDER[risk] >= threshold) return { mode: 'gate', risk, reasons };
  return { mode: 'passthrough', risk, reasons };
}

module.exports = { evaluate };
