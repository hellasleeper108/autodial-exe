// resources.js — real, current, US-focused support lines. This is Layer 1:
// always reachable from the main menu ([H]), never gated behind an easter
// egg. Keep this file accurate over time — it's the one thing here that
// actually needs to be right.

const RESOURCES = [
  {
    category: "Suicide & Crisis",
    items: [
      { label: "988 Suicide & Crisis Lifeline", detail: "call or text 988 — free, confidential, 24/7 (US)" },
      { label: "Crisis Text Line", detail: "text HOME to 741741" },
      { label: "Outside the US", detail: "findahelpline.com" },
    ],
  },
  {
    category: "Veterans",
    items: [
      { label: "Veterans Crisis Line", detail: "dial 988 then press 1 — or text 838255 — or chat at veteranscrisisline.net" },
      { label: "VA general info line", detail: "1-800-698-2411" },
    ],
  },
  {
    category: "Trauma & Mental Health",
    items: [
      { label: "SAMHSA National Helpline", detail: "1-800-662-4357 — 24/7 treatment referral & info" },
      { label: "NAMI HelpLine", detail: "1-800-950-6264 — call or text" },
    ],
  },
  {
    category: "Substance Use",
    items: [
      { label: "SAMHSA National Helpline", detail: "1-800-662-4357 — same line, also covers substance use" },
      { label: "Treatment locator", detail: "findtreatment.gov" },
    ],
  },
];

if (typeof module !== "undefined" && module.exports) {
  module.exports = { RESOURCES };
} else {
  window.RESOURCES = RESOURCES;
}
