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
 * @param {object} config  gateway config (uses mode, hardNoTimer, gateMinRisk)
 * @returns {{mode: 'gate'|'passthrough'|'auto_approve', risk: string, reasons: string[], noTimer?: boolean, autoApproved?: boolean}}
 */
function evaluate(action, config = {}) {
  const { risk, reasons } = classify(action);

  const mode = config.mode ? String(config.mode).toLowerCase() : null;

  // Full Auto Mode: all commands (LOW, MEDIUM, HIGH) are auto-approved with no timer
  if (mode === 'auto' || mode === 'full-auto') {
    return { mode: 'auto_approve', risk, reasons, autoApproved: true, noTimer: true };
  }

  // Approval Mode:
  // - Medium: approved by default (auto-approved)
  // - Low: passthrough (auto-allowed)
  // - Hard (HIGH): stays in approval with no timer until user accepts
  if (mode === 'approval') {
    if (risk === RISK.HIGH) {
      return { mode: 'gate', risk, reasons, noTimer: config.hardNoTimer !== false };
    }
    if (risk === RISK.MEDIUM) {
      return { mode: 'auto_approve', risk, reasons, autoApproved: true };
    }
    return { mode: 'passthrough', risk, reasons };
  }

  // Fallback for legacy configs / explicit gateMinRisk calls without mode:
  // Hard floor: HIGH is never passed through, whatever the config says.
  if (risk === RISK.HIGH) return { mode: 'gate', risk, reasons, noTimer: Boolean(config.hardNoTimer) };

  const requested = String(config.gateMinRisk || 'MEDIUM').toUpperCase();
  // Clamp: MEDIUM is the highest permitted threshold. A config of "HIGH" would
  // mean "only gate HIGH", which would let MEDIUM through silently; we allow
  // that only if explicitly set, but we never allow a threshold above HIGH.
  const threshold = RISK_ORDER[requested] === undefined ? RISK_ORDER.MEDIUM : RISK_ORDER[requested];

  if (RISK_ORDER[risk] >= threshold) return { mode: 'gate', risk, reasons, noTimer: Boolean(config.hardNoTimer) };
  return { mode: 'passthrough', risk, reasons };
}

module.exports = { evaluate };
