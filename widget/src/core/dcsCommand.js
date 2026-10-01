/**
 * DCS command pop-up: what the DCS (the site's control system, over Modbus)
 * just asked the pump controller to do, and how it went, in plain words for
 * the local panel. Pure (no DOM, no timers); the render core draws the card
 * and runs its timers. Unit-tested in tests/dcsCommand.test.mjs.
 *
 * Source: the controller's DCS result tags (payload `dcs_command`, built by
 * lib/assembleDashboardData.ts only with the HMI's `dcs_connected` on):
 *
 *   seq          DcsCmdSeq: +1 per command the DCS sends (accepted, refused
 *                or invalid), set in the same flush as the others below
 *   command      DcsLastCommand: STOP 0, START 2, SET_RATE 3,
 *                RESET_PROCESS 4, RESET_VSD 5, alarm delays 6..11
 *   result       DcsCmdResult: 0 idle, 1 pending, 2 ok, 3 failed
 *   error        DcsCmdError: the Rev 0.3 error table (0 none)
 *   request      DcsCmdRequest: the value the DCS wrote (rate units, run
 *                0 / 2, reset 4 / 5, delay seconds)
 *   applied_rate DcsAppliedRate: the target rate a rate command applied
 */

/** DcsCmdResult. */
export const DCS_RESULT = Object.freeze({ IDLE: 0, PENDING: 1, OK: 2, FAILED: 3 });

/** DcsLastCommand codes (the controller's DcsCommand). */
export const DCS_COMMAND = Object.freeze({
  STOP: 0,
  START: 2,
  SET_RATE: 3,
  RESET_PROCESS: 4,
  RESET_VSD: 5,
});

/** The alarm delay commands 6..11, by code: the alarm they delay. */
export const DCS_DELAY_ALARMS = Object.freeze({
  6: "Pressure H",
  7: "Pressure HH",
  8: "Tank L",
  9: "Tank LL",
  10: "Flow L",
  11: "Flow LL",
});

/**
 * DcsCmdError in operator language (the controller's DcsError). Codes not
 * listed read "error N".
 */
export const DCS_ERROR_TEXT = Object.freeze({
  1: "invalid value",
  2: "controller unavailable",
  3: "pump is tripped",
  5: "busy",
  7: "fault still active",
  8: "timed out",
  13: "drive still tripped",
  14: "drive not tripped",
  15: "control disabled",
});

export const DCS_NOTICE_TITLE = "DCS command";
export const DCS_PENDING_TEXT = "Received - applying...";
export const DCS_NO_ANSWER_TEXT = "no answer from the pump controller";
/** The card stays this long after the final result (or after "no answer"). */
export const DCS_NOTICE_HOLD_MS = 8000;
/** Still pending this long: "no answer from the pump controller". */
export const DCS_NOTICE_PENDING_MS = 20000;

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** A request value as the DCS wrote it: whole numbers plain, else 2 dp at most. */
function plain(n) {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

function rateText(n, units) {
  return `${n.toFixed(2)}${units ? " " + units : ""}`;
}

/** The refusal reason for a DcsCmdError ("" for none). */
export function dcsErrorText(error) {
  if (!isNum(error) || error === 0) return "";
  return DCS_ERROR_TEXT[error] || `error ${plain(error)}`;
}

/**
 * The command in plain words: "Start pump", "Target rate 15.00 L/Hr",
 * "Tank L alarm delay 601 s". A run or reset write the controller could not
 * read as one (e.g. 7 on the run register, reported as START / RESET_PROCESS
 * with error 1) is named by the value written: "Run request 7".
 */
export function dcsCommandWhat(dcs, rateUnits) {
  const cmd = dcs ? dcs.command : null;
  const req = dcs && isNum(dcs.request) ? dcs.request : null;
  switch (cmd) {
    case DCS_COMMAND.STOP:
    case DCS_COMMAND.START: {
      const expected = cmd === DCS_COMMAND.START ? 2 : 0;
      if (req !== null && req !== expected) return `Run request ${plain(req)}`;
      return cmd === DCS_COMMAND.START ? "Start pump" : "Stop pump";
    }
    case DCS_COMMAND.SET_RATE:
      return req !== null ? `Target rate ${rateText(req, rateUnits)}` : "Target rate";
    case DCS_COMMAND.RESET_PROCESS:
    case DCS_COMMAND.RESET_VSD: {
      const expected = cmd === DCS_COMMAND.RESET_VSD ? 5 : 4;
      if (req !== null && req !== expected) return `Reset request ${plain(req)}`;
      return cmd === DCS_COMMAND.RESET_VSD ? "VSD fault reset" : "Process fault reset";
    }
    default:
      if (isNum(cmd) && DCS_DELAY_ALARMS[cmd]) {
        return `${DCS_DELAY_ALARMS[cmd]} alarm delay${req !== null ? ` ${plain(req)} s` : ""}`;
      }
      return isNum(cmd) ? `Command ${plain(cmd)}` : "Command";
  }
}

/**
 * What the card says for this command right now:
 * {state: "pending" | "ok" | "failed" | "timeout", what, status, text}
 * with text = "<what> - <status>", e.g. "Start pump - done",
 * "Target rate 15.00 L/Hr - limited to 13.10 L/Hr",
 * "VSD fault reset - refused: drive not tripped".
 *
 * `timedOut`: it was still pending at DCS_NOTICE_PENDING_MS; it reads
 * "no answer from the pump controller" until a final result arrives.
 */
export function dcsNotice(dcs, rateUnits, { timedOut = false } = {}) {
  const what = dcsCommandWhat(dcs, rateUnits);
  const result = dcs ? dcs.result : null;
  let state;
  let status;
  if (result === DCS_RESULT.OK) {
    state = "ok";
    status = "done";
    if (dcs.command === DCS_COMMAND.SET_RATE) {
      const applied = isNum(dcs.applied_rate) ? dcs.applied_rate : isNum(dcs.request) ? dcs.request : null;
      if (applied !== null) {
        const limited = isNum(dcs.request) && Math.abs(applied - dcs.request) >= 0.005;
        status = `${limited ? "limited to" : "set to"} ${rateText(applied, rateUnits)}`;
      }
    }
  } else if (result === DCS_RESULT.FAILED) {
    state = "failed";
    const why = dcsErrorText(dcs.error);
    status = why ? `refused: ${why}` : "refused";
  } else if (timedOut) {
    state = "timeout";
    status = DCS_NO_ANSWER_TEXT;
  } else {
    // Pending, or idle / unknown before any answer.
    state = "pending";
    status = DCS_PENDING_TEXT;
  }
  return { state, what, status, text: `${what} - ${status}` };
}

/**
 * Follow DcsCmdSeq from one payload to the next and say when a new DCS
 * command arrived. `prev` is the last baseline: undefined before the first
 * payload, then the last non-null sequence seen (or null while none has
 * been).
 *
 *  - The first payload only sets the baseline, whatever it holds: the tags
 *    carry no time, so a command already there at load (a reload, or a
 *    reconnect, which resets `prev`) may be a minute or a month old.
 *  - A change to a new non-null value is a new command (show it), except
 *    0 after none (a controller publishing its first sequence at boot) and
 *    a step back (a reinstalled controller; DcsCmdSeq never goes back):
 *    both only move the baseline.
 *  - null (not published) keeps the baseline, so a tag that drops out and
 *    returns unchanged is not news.
 *
 * -> {key: the new baseline, show: boolean}
 */
export function followDcsSeq(prev, seq) {
  const value = isNum(seq) ? seq : null;
  if (prev === undefined) return { key: value, show: false };
  if (value === null || value === prev) return { key: prev, show: false };
  const show = prev === null ? value > 0 : value > prev;
  return { key: value, show };
}
