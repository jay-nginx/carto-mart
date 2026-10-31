// Feature flags for the Carto demo.
//
// WHY A HOME-GROWN EVALUATOR
// ==========================
// Datadog's RUM Feature Flag Tracking has turnkey integrations for
// LaunchDarkly, Split, Flagsmith, OpenFeature and others, but all of them are
// an external dependency and an account. The thing Datadog actually consumes
// is a single SDK call per evaluation — `addFeatureFlagEvaluation(key, value)`
// in the browser, plus a span tag on the backend. So a deterministic local
// evaluator gives the identical Datadog experience with nothing to sign up
// for, and keeps the harness self-contained.
//
// If you want to demo a real vendor integration instead, swap `evaluate()` for
// that vendor's SDK and keep the reporting calls exactly as they are.
//
// DETERMINISM MATTERS
// ===================
// A flag that flips on every request is useless: the cohort boundary is the
// whole point of flag-correlated analysis. Evaluation is therefore a stable
// hash of (flag key, subject id), so a given shopper stays in the same cohort
// across their whole session and across services — the browser, the BFF and
// the Python services all independently compute the same answer for the same
// shopper without having to pass it around.

const crypto = require('crypto');

// Each flag has:
//   rollout  0..100, the percentage of subjects for whom the flag is ON
//   targets  explicit per-subject overrides, evaluated BEFORE the percentage
//
// `targets` is not a shortcut — individual targeting is a first-class feature
// of every real flag platform (LaunchDarkly calls it individual targeting,
// Split calls it whitelists) and it is how an actual canary release starts:
// pin the canary subjects, watch them, then ramp the percentage.
//
// It also makes the demo deterministic. The four seeded shoppers all happen to
// hash into high buckets, so a realistic 20% rollout would exclude every one
// of them and the flagship regression would never fire for a demo user.
// Pinning one shopper fixes that honestly, without distorting the hash.
//
// Tune via env so a demo can force a cohort: CARTO_FLAG_<KEY>_ROLLOUT=100
const FLAGS = {
  // Cosmetic: a redesigned product tile. Safe, half the traffic. Exists so the
  // demo has a flag where the interesting answer is "no impact" — which is
  // itself the point of flag-correlated dashboards.
  product_tile_v2: {
    rollout: 50,
    targets: {},
    description: 'Redesigned product tile layout',
    kind: 'ui',
  },
  // PRESENTATION ONLY. Chooses whether this week's range is merchandised as a
  // prominent hero shelf or a compact strip.
  //
  // It used to gate whether the shelf rendered AT ALL, which was a mistake: a
  // visitor outside the cohort saw no shelf either way, so when the range was
  // missing there was nothing to notice — no empty shelf, and not even the
  // failure banner, because that was inside the same conditional. The shelf now
  // always renders and shows its own emptiness; the flag only changes how it
  // looks, so the cohort story survives without hiding the failure.
  new_range_carousel: {
    rollout: 60,
    // The two shoppers a presenter actually signs in as are pinned ON, so the
    // homepage carousel — and therefore the empty-shelf failure — is visible
    // on the first click rather than depending on which side of a 60% hash
    // they landed. carol and dan stay on the hash, so the cohort split is
    // still real in the data.
    // raj (CT-CUST-9001) is pinned ON with the two presenter logins, so the
    // new-range carousel — and therefore the empty-shelf failure — is on
    // screen for whichever account is being driven.
    targets: { 'CT-CUST-1001': true, 'CT-CUST-1002': true, 'CT-CUST-9001': true },
    description: 'Hero (vs compact) presentation of the newly published range',
    kind: 'experiment',
  },
  // THE INTERESTING ONE. A "rewritten" express-checkout path that is genuinely
  // worse: it adds a redundant re-price round trip and throws on carts whose
  // total has a fractional cents rounding edge. The blame is real rather than
  // narrated — the error and the latency only occur for subjects in this
  // cohort, so Datadog's flag-correlated error rate and latency views tell the
  // true story.
  express_checkout_v2: {
    rollout: 20,
    // bob is the pinned canary: sign in as bob and check out, and the
    // regression fires. The other three seeded shoppers are outside the
    // cohort, which is what makes the Error Tracking group-by-flag comparison
    // meaningful rather than uniform.
    // bob (CT-CUST-1001) is the pinned canary: sign in as bob, check out a
    // basket over $100, and the regression fires every time. The other three
    // seeded shoppers are pinned OUT.
    //
    // WHY PIN THEM OUT RATHER THAN LEAVE THEM TO THE HASH
    // ===================================================
    // At a 20% rollout, two of the four seeded shoppers happened to hash into
    // the cohort — so half of all demo checkouts failed, which reads as a
    // broken app rather than as a canary. Pinning the other three out keeps
    // the cohort boundary meaningful (bob in, everyone else out) without
    // touching the hash, and individual targeting is a first-class feature of
    // every real flag platform. Traffic from the load driver still splits
    // 20/80 across anonymous subjects, so the aggregate error rate stays
    // realistic.
    targets: {
      'CT-CUST-1001': true,
      'CT-CUST-1002': false,
      'CT-CUST-1003': false,
      'CT-CUST-1004': false,
      // raj is pinned OUT. His journeys must be clean and green by default,
      // because the monitor watching his customer id emails a human — an
      // account that fails on every checkout would turn that alert into
      // noise before the demo starts. Failures for raj are injected
      // deliberately: GET /api/demo/user-break.
      'CT-CUST-9001': false,
    },
    description: 'Rewritten express checkout path (deliberately regressed)',
    kind: 'release',
  },
};

// Env overrides, so a demo can pin a cohort without a rebuild.
for (const [key, def] of Object.entries(FLAGS)) {
  const envKey = `CARTO_FLAG_${key.toUpperCase()}_ROLLOUT`;
  const raw = process.env[envKey];
  if (raw !== undefined && raw !== '') {
    const pct = Number(raw);
    if (Number.isFinite(pct) && pct >= 0 && pct <= 100) def.rollout = pct;
  }
}

// Stable bucket in [0,100) for a (flag, subject) pair. Hashing the flag key in
// alongside the subject means the cohorts for different flags are independent
// — without it, every 20% flag would select the same unlucky 20% of shoppers and
// their effects would be impossible to separate.
function bucket(flagKey, subject) {
  const h = crypto.createHash('sha1').update(`${flagKey}:${subject}`).digest();
  return ((h[0] << 8) | h[1]) % 100;
}

function evaluate(flagKey, subject) {
  const def = FLAGS[flagKey];
  if (!def) return false;
  // Individual targeting wins over the percentage rollout, as it does in every
  // real flag platform.
  if (def.targets && Object.prototype.hasOwnProperty.call(def.targets, subject)) {
    return Boolean(def.targets[subject]);
  }
  if (def.rollout >= 100) return true;
  if (def.rollout <= 0) return false;
  return bucket(flagKey, subject) < def.rollout;
}

// The full set for a subject. Sent to the browser so the SPA reports the same
// values to RUM that the backend acted on — one source of truth per shopper.
function evaluateAll(subject) {
  const out = {};
  for (const key of Object.keys(FLAGS)) out[key] = evaluate(key, subject);
  return out;
}

// Runtime rollout override, used by the demo control surface
// (GET /api/demo/*) to widen a cohort mid-demo without a restart.
//
// Real flag platforms change rollouts through their own API; this is the local
// equivalent. Evaluation stays deterministic, so a subject's cohort only
// changes because the ROLLOUT changed, not because the hash moved.
function setRollout(flagKey, pct) {
  const def = FLAGS[flagKey];
  if (!def) return false;
  const n = Number(pct);
  if (!Number.isFinite(n) || n < 0 || n > 100) return false;
  def.rollout = n;
  return true;
}

// Runtime INDIVIDUAL TARGETING override, used by the demo control surface.
//
// setRollout() moves the whole cohort boundary, which is the wrong tool when a
// presenter is driving the entire demo as one shopper: widening a percentage
// does not reliably capture one specific subject, and narrowing it does not
// reliably release them. Real flag platforms solve this with per-subject
// targeting, so this is the local equivalent — pin exactly one customer id in
// or out, leaving the percentage (and therefore the load driver's cohort
// split, and the aggregate story on the dashboards) completely untouched.
//
// Pass value === null to REMOVE the override and hand the subject back to the
// percentage hash.
function setTarget(flagKey, subject, value) {
  const def = FLAGS[flagKey];
  if (!def || !subject) return false;
  def.targets = def.targets || {};
  if (value === null || value === undefined) {
    delete def.targets[subject];
  } else {
    def.targets[subject] = Boolean(value);
  }
  return true;
}

function definitions() {
  return Object.entries(FLAGS).map(([key, d]) => ({
    key,
    rollout: d.rollout,
    targeted: Object.keys(d.targets || {}),
    targets: { ...(d.targets || {}) },
    description: d.description,
    kind: d.kind,
  }));
}

module.exports = { FLAGS, evaluate, evaluateAll, definitions, setRollout, setTarget };
