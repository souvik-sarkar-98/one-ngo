import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const plan = fs.readFileSync(path.join(dir, "functional-test-plan.md"), "utf8");
const manual = fs.readFileSync(path.join(dir, "manual-test-plan.md"), "utf8");

const SMOKE = new Set(
  `FT-OPC-001 FT-OPC-040 FT-OPC-070 FT-OPC-080 FT-AUTH-004 FT-AUTH-020 FT-AUTH-060 FT-AUTH-065 FT-AUTH-100 FT-NAV-005 FT-HOME-001 FT-REC-043 FT-REC-047 FT-REC-109 FT-WF-021 FT-WF-024 FT-DON-020 FT-DON-026 FT-DON-035 FT-DON-037 FT-DON-040 FT-FIN-028 FT-FIN-069 FT-ADM-028 FT-ADM-080 FT-ADM-082 FT-BLD-007 FT-ISO-001 FT-OPC-087`.split(
    " ",
  ),
);

const TYPE_LABEL = {
  Pos: "Positive",
  Neg: "Negative",
  Bnd: "Boundary",
  Sec: "Security",
  Con: "Concurrency",
  UI: "Layout",
  API: "API",
  E2E: "Journey",
  Charter: "Charter",
};

const WHEN = [
  ["Any change", "Smoke"],
  ["Sign-in or session code", "Sign-in in full, FT-OPC-016, and tenant isolation"],
  ["Records, fields, or definitions", "Records, workflows, Builder, and tenant isolation"],
  ["Money, receipts, or payments", "Donations and finance in full, plus journeys E2E-02, E2E-03, and E2E-07"],
  ["Administration or people", "Administration in full, and FT-AUTH-103"],
  ["Connectors, templates, or scripts", "Runtime engines in full"],
  ["Web shell or layout", "Shell, Home, offline, and accessibility"],
  ["Release candidate", "Smoke first, then every P0 and P1 scenario"],
];

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatInline(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function cells(line) {
  const holder = "\u0000";
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .replace(/\\\|/g, holder)
    .split("|")
    .map((cell) => cell.trim().replaceAll(holder, "|"));
}

function splitOutside(text, separator) {
  const parts = [];
  let current = "";
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    if (depth === 0 && text.startsWith(separator, i)) {
      parts.push(current);
      current = "";
      i += separator.length - 1;
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

function sentence(value) {
  let text = value.trim().replace(/\s+/g, " ");
  text = text.replace(/^[.;,\s]+|[.;\s]+$/g, "");
  if (!text) return "";
  const first = text[0];
  if (first >= "a" && first <= "z") return first.toUpperCase() + text.slice(1);
  return text;
}

function splitCompound(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.includes("→")) return splitOutside(trimmed, "→").map(sentence);
  const semi = splitOutside(trimmed, ";");
  if (semi.length > 1) return semi.map(sentence);
  return [sentence(trimmed)];
}

function expectedParts(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const semi = splitOutside(trimmed, ";");
  if (semi.length > 1) return semi.map(sentence);
  const sentences = trimmed.split(/(?<=\.)\s+(?=[A-Z"“])/);
  if (sentences.length > 1) return sentences.map((part) => part.trim()).filter(Boolean);
  return [trimmed];
}

function shorten(text, max) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > 40 ? cut.slice(0, space) : cut).trim()}…`;
}

function parseManual(markdown) {
  const results = new Map();
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.startsWith("| MT-")) continue;
    const cols = cells(line);
    const id = cols[0]?.match(/^MT-[A-Z]+-\d+/)?.[0];
    if (!id || cols.length < 5) continue;
    const status = cols[4];
    const result = status.match(/^(Pass|Fail|Partial|Blocked|Not run)/i)?.[1] ?? "Noted";
    const defects = [...new Set([...status.matchAll(/DEF-\d+/g)].map((match) => match[0]))];
    results.set(id, { result, defects, note: status });
  }
  return results;
}

const manualResults = parseManual(manual);

function parsePlan(markdown) {
  const areas = [];
  let area = null;
  let include = false;
  let group = "Main";
  let note = [];
  let header = null;
  let charter = 0;
  const warnings = [];

  function flushNote() {
    const text = note.join(" ").replace(/\s+/g, " ").trim();
    note = [];
    return text;
  }

  function ensureArea(number, title) {
    const codeMatch = title.match(/\(`([A-Z0-9]+)`(?:,[^)]*)?\)\s*$/);
    const code = codeMatch?.[1] ?? (number === "31" ? "CHR" : number === "33" ? "PK" : `S${number}`);
    const stripped = title.replace(/\s*\(`([A-Z0-9]+)`(?:,[^)]*)?\)\s*$/, "").trim();
    const name = number === "33" ? "Passkeys" : stripped;
    area = {
      code,
      name,
      number,
      pending: number === "33",
      intro: "",
      groups: [],
    };
    areas.push(area);
    group = "Main";
    include = (Number(number) >= 10 && Number(number) <= 31) || number === "33";
  }

  function currentGroup(setup) {
    let name = group;
    let text = setup;
    const bold = text.match(/^\*\*([^*]+)\*\*/);
    if (bold) {
      name = bold[1];
      text = text.replace(/^\*\*([^*]+)\*\*/, "").replace(/^\s*\([^)]*\)\s*/, "").replace(/^[.:]\s*/, "").trim();
    }
    setup = text;
    let found = area.groups.find((item) => item.name === name && item.setup === setup);
    if (!found) {
      found = { name, setup, scenarios: [] };
      area.groups.push(found);
    }
    return found;
  }

  for (const line of markdown.split(/\r?\n/)) {
    const h2 = line.match(/^##\s+(\d+)\.\s+(.+)$/);
    if (h2) {
      flushNote();
      header = null;
      ensureArea(h2[1], h2[2]);
      continue;
    }
    if (!include || !area) continue;

    const h3 = line.match(/^###\s+\d+(?:\.\d+)?\s+(.+)$/);
    if (h3) {
      const text = flushNote();
      if (!area.intro && text) area.intro = text;
      header = null;
      group = h3[1].trim();
      continue;
    }

    if (!line.trim()) {
      header = null;
      continue;
    }

    if (line.startsWith("|")) {
      const cols = cells(line);
      if (cols.every((cell) => /^:?-+:?$/.test(cell))) continue;
      if (/^ID$|^Charter$/i.test(cols[0])) {
        const setup = flushNote();
        if (!area.intro && setup && group === "Main") area.intro = setup;
        header = { cols: cols.map((cell) => cell.toLowerCase()), setup: setup === area.intro ? "" : setup, group };
        continue;
      }
      if (!header) continue;
      if (cols.length !== header.cols.length) {
        warnings.push(`${cols[0]} has ${cols.length} cells, header has ${header.cols.length}`);
      }
      const scenario = buildScenario(cols, header, area);
      if (!scenario) continue;
      if (scenario.id.startsWith("CHR-")) charter += 1;
      currentGroup(header.setup).scenarios.push(scenario);
      continue;
    }

    if (!header && !line.startsWith("#")) note.push(line.replace(/\s+/g, " ").trim());
  }

  return { areas: areas.filter((item) => item.groups.some((groupItem) => groupItem.scenarios.length)), warnings, charter };
}

function cleanSetup(setup, groupName) {
  let text = setup.trim();
  const bold = text.match(/^\*\*([^*]+)\*\*/);
  if (bold && bold[1] === groupName) {
    text = text.replace(/^\*\*([^*]+)\*\*/, "").replace(/^\s*\([^)]*\)\s*/, "").trim();
    text = text.replace(/^[.:]\s*/, "");
  }
  return text;
}

function column(header, names) {
  return names.map((name) => header.indexOf(name)).find((index) => index >= 0) ?? -1;
}

function buildScenario(cols, header, area) {
  const names = header.cols;
  const idCell = cols[0] ?? "";
  const isCharter = names[0] === "charter";
  let id = "";
  let refs = [];
  if (isCharter) {
    id = `CHR-${String(area.groups.reduce((sum, groupItem) => sum + groupItem.scenarios.length, 0) + 1).padStart(2, "0")}`;
  } else {
    const match = idCell.match(/^(FT-[A-Z][A-Z0-9]*-\d+)\s*(?:\[([^\]]+)\])?/);
    if (!match) return null;
    id = match[1];
    refs = match[2] ? match[2].split(",").map((item) => item.trim()).filter((item) => /^MT-/.test(item)) : [];
  }

  const priIndex = column(names, ["pri"]);
  const typeIndex = column(names, ["type"]);
  const stepsIndex = column(names, ["steps", "steps and values", "field and value", "value", "focus"]);
  const expectedIndex = column(names, ["expected", "expected end state"]);
  const fieldIndex = column(names, ["field", "kind", "journey"]);
  const priority = priIndex >= 0 ? cols[priIndex] : isCharter ? "—" : "P0";
  const type = typeIndex >= 0 ? cols[typeIndex] : isCharter ? "Charter" : names.includes("journey") ? "E2E" : "Pos";
  const field = fieldIndex >= 0 ? cols[fieldIndex] : "";
  const rawSteps = stepsIndex >= 0 ? cols[stepsIndex] : "";
  const expected =
    expectedIndex >= 0 && cols[expectedIndex]
      ? cols[expectedIndex]
      : isCharter
        ? "Record the persona, the record type, and anything you would file. Stop at 45 minutes."
        : "";
  const kind = kindOf(names);
  const steps = stepsFor(kind, field, rawSteps);
  const title = titleFor(kind, field, idCell, rawSteps, steps);
  const manualLinks = refs.map((ref) => ({ id: ref, ...(manualResults.get(ref) ?? { result: "", defects: [], note: "" }) }));

  return {
    id,
    priority,
    type,
    title,
    steps,
    expected: expectedParts(expected),
    groupName: header.group,
    suite: SMOKE.has(id) ? "smoke" : "regression",
    pending: area.pending,
    manualLinks,
    search: [id, title, field, rawSteps, expected, ...refs, ...steps].join(" ").toLowerCase(),
  };
}

function kindOf(names) {
  if (names[0] === "charter") return "charter";
  if (names.includes("journey")) return "e2e";
  if (names.includes("field") && names.includes("steps and values")) return "field-type";
  if (names.includes("kind")) return "builder-kind";
  if (names.includes("field and value")) return "field-value";
  if (names.includes("value") && !names.includes("steps")) return "password-value";
  return "steps";
}

function stepsFor(kind, field, raw) {
  if (kind === "field-value") {
    if (/^valid request$/i.test(raw.trim())) {
      return [
        "Sign in to the operator console as an operator who can onboard.",
        "Open Onboard and paste the valid Riverbank request, using a request id that has not been used.",
        "Choose Validate.",
      ];
    }
    const looksLikeValues = raw.includes("`") || /\b(characters|chars|refused|accepted)\b/i.test(raw);
    if (!looksLikeValues) {
      return [
        "Sign in to the operator console as an operator who can onboard.",
        ...splitCompound(raw.includes(";") ? raw : raw.replace(/, /g, "; ")),
      ];
    }
    return [
      "Sign in to the operator console as an operator who can onboard.",
      "Open Onboard and paste the valid Riverbank request.",
      ...splitCompound(raw).map((part) => `Change only this, then choose Validate: ${part}.`),
      "Use a fresh request id if an earlier draft was accepted. Do not choose Provision.",
    ];
  }
  if (kind === "password-value") {
    const values = raw.split(/\s+\/\s+/).map((part) => part.trim()).filter(Boolean);
    return [
      "Open a password reset link, or an invitation. The same password rules apply to both.",
      ...values.map((value) => `Enter ${value} and try to save.`),
    ];
  }
  if (kind === "field-type") {
    return [
      `Open a record whose form includes the ${field} field. Use Donations where it has that field, otherwise a throwaway type from Builder.`,
      ...splitCompound(raw).map((part) => `Check this value or action: ${part}.`),
    ];
  }
  if (kind === "builder-kind") {
    return [`In Builder, on a desktop-width window, open ${field}.`, ...splitCompound(raw)];
  }
  if (kind === "charter") {
    return [
      "Time-box this charter to 45 minutes.",
      "Write down the persona and the record type before you start.",
      ...splitCompound(raw).map((part) => `Explore: ${part}.`),
      "Write down what you tried and anything you would file.",
    ];
  }
  if (kind === "e2e") return splitCompound(raw);
  return splitCompound(raw);
}

function titleFor(kind, field, idCell, raw, steps) {
  if (kind === "e2e") return field;
  if (kind === "charter") return idCell;
  if (kind === "field-type") return `${field}: ${shorten(raw, 90)}`;
  if (kind === "builder-kind") return `${field}: ${shorten(raw, 90)}`;
  if (kind === "field-value") return shorten(raw, 110);
  if (kind === "password-value") return `Password: ${shorten(raw, 90)}`;
  return shorten(steps[0] || raw, 120);
}

function shareSetup(group) {
  const setups = [...new Set(group.scenarios.map((scenario) => scenario.setup).filter(Boolean))];
  return setups.length === 1 ? setups[0] : "";
}

const parsed = parsePlan(plan);
const missingSmoke = [...SMOKE].filter(
  (id) => !parsed.areas.some((area) => area.groups.some((group) => group.scenarios.some((scenario) => scenario.id === id))),
);

const FLOWS = [
  {
    id: "open-ngo",
    title: "Open a new NGO",
    e2e: "FT-E2E-01",
    blurb: "One operator session, one valid Riverbank request, then the invited administrator finishes setup and invites Finance. Use a fresh request id.",
    stages: [
      { name: "Sign in to the console", ids: ["FT-OPC-001", "FT-OPC-003", "FT-OPC-014"] },
      {
        name: "Reject bad drafts, then validate",
        ids: [
          "FT-OPC-064", "FT-OPC-041", "FT-OPC-042", "FT-OPC-043", "FT-OPC-044", "FT-OPC-045", "FT-OPC-046", "FT-OPC-047",
          "FT-OPC-048", "FT-OPC-049", "FT-OPC-050", "FT-OPC-051", "FT-OPC-052", "FT-OPC-053", "FT-OPC-054", "FT-OPC-055",
          "FT-OPC-056", "FT-OPC-057", "FT-OPC-058", "FT-OPC-059", "FT-OPC-060", "FT-OPC-061", "FT-OPC-062", "FT-OPC-040", "FT-OPC-063",
        ],
      },
      { name: "Provision once", ids: ["FT-OPC-070", "FT-OPC-071", "FT-OPC-072", "FT-OPC-077"] },
      { name: "Set the invitation password", ids: ["FT-AUTH-065", "FT-AUTH-040", "FT-AUTH-041", "FT-AUTH-042", "FT-AUTH-043", "FT-AUTH-046", "FT-AUTH-066"] },
      { name: "Finish setup and invite Finance", ids: ["FT-NAV-001", "FT-NAV-008", "FT-ADM-001", "FT-ADM-002", "FT-ADM-003", "FT-ADM-004", "FT-ADM-005", "FT-ADM-006", "FT-ADM-020", "FT-ADM-021", "FT-ADM-007", "FT-E2E-01"] },
    ],
  },
  {
    id: "sign-in",
    title: "Member sign-in",
    e2e: "",
    blurb: "One member, one organisation. Password, email code, reset, and a second device. Do not lock the account; that is the next flow.",
    stages: [
      { name: "Find the organisation", ids: ["FT-AUTH-001", "FT-AUTH-002", "FT-AUTH-007", "FT-AUTH-008", "FT-AUTH-005"] },
      { name: "Password", ids: ["FT-AUTH-020", "FT-AUTH-021", "FT-AUTH-030"] },
      { name: "Email code", ids: ["FT-AUTH-050", "FT-AUTH-051", "FT-AUTH-057", "FT-AUTH-058"] },
      { name: "Reset the password", ids: ["FT-AUTH-060", "FT-AUTH-061", "FT-AUTH-063"] },
      { name: "Two devices and a deep link", ids: ["FT-AUTH-100", "FT-AUTH-105", "FT-NAV-011"] },
    ],
  },
  {
    id: "locked",
    title: "Locked sign-in",
    e2e: "",
    blurb: "A spare member. Five wrong passwords end this password path. Clear the lock with an email code, then with a reset.",
    stages: [{ name: "Lock, then clear it", ids: ["FT-AUTH-022", "FT-AUTH-023", "FT-AUTH-024"] }],
  },
  {
    id: "donation",
    title: "Donation to receipt",
    e2e: "FT-E2E-02",
    blurb: "Finance on Fundraising. Create the donor and donations, mark one paid by UPI, print the receipt, and open the public link signed out. Keep one Raised donation for the reminder and one for Cancel.",
    stages: [
      { name: "Open the lists", ids: ["FT-REC-001", "FT-REC-010", "FT-REC-011", "FT-REC-026"] },
      { name: "Create the donor", ids: ["FT-DON-005", "FT-DON-002", "FT-DON-001", "FT-DON-004", "FT-DON-003", "FT-DON-006", "FT-DON-007", "FT-DON-008"] },
      { name: "Create the donation", ids: ["FT-REC-042", "FT-REC-044", "FT-DON-021", "FT-DON-022", "FT-DON-023", "FT-DON-024", "FT-DON-020", "FT-REC-104", "FT-DON-025"] },
      { name: "Mark as paid", ids: ["FT-DON-027", "FT-DON-029", "FT-DON-030", "FT-DON-026", "FT-DON-031"] },
      { name: "Receipt, posting, and public link", ids: ["FT-DON-032", "FT-DON-034", "FT-DON-035", "FT-DON-037", "FT-DON-009", "FT-DON-038", "FT-DON-055", "FT-FIN-026", "FT-FIN-027", "FT-FIN-028", "FT-DON-036"] },
      { name: "Reminder and cancel", ids: ["FT-DON-050", "FT-DON-051", "FT-DON-033"] },
      { name: "Viewer on the same records", ids: ["FT-DON-040", "FT-REC-109", "FT-E2E-02"] },
    ],
  },
  {
    id: "gateway",
    title: "Online payment",
    e2e: "FT-E2E-03",
    blurb: "One Raised donation and the Razorpay fixture. Send the bad webhooks while it is still Raised, then capture it.",
    stages: [
      { name: "Pay now", ids: ["FT-DON-053", "FT-DON-054"] },
      { name: "Bad webhooks, still Raised", ids: ["FT-FIN-070", "FT-FIN-071"] },
      { name: "Capture, duplicate, and a failed payment", ids: ["FT-FIN-068", "FT-FIN-069", "FT-FIN-072", "FT-E2E-03"] },
    ],
  },
  {
    id: "approval",
    title: "Approval",
    e2e: "FT-E2E-04",
    blurb: "A published two-approval step. The requester sends it, two approvers decide from Inbox, then the requester withdraws a second request.",
    stages: [
      { name: "Request and decide", ids: ["FT-WF-020", "FT-WF-021", "FT-WF-022", "FT-WF-023", "FT-WF-024", "FT-WF-025"] },
      { name: "Inbox", ids: ["FT-WF-050", "FT-WF-051", "FT-WF-053", "FT-WF-054", "FT-NAV-009"] },
      { name: "Withdraw", ids: ["FT-WF-030", "FT-E2E-04"] },
    ],
  },
  {
    id: "import",
    title: "Import and bulk",
    e2e: "FT-E2E-05",
    blurb: "One donor import, then an update by PAN, then a bulk edit on the rows that landed. Jobs stay open in another administrator session.",
    stages: [
      { name: "Import donors", ids: ["FT-REC-170", "FT-REC-171", "FT-REC-173", "FT-REC-174", "FT-REC-175", "FT-REC-176", "FT-REC-178", "FT-REC-180", "FT-REC-186", "FT-REC-187"] },
      { name: "Bulk on the imported rows", ids: ["FT-REC-220", "FT-REC-222", "FT-REC-223", "FT-REC-225", "FT-REC-226", "FT-REC-228"] },
      { name: "Jobs and a role", ids: ["FT-REC-233", "FT-ADM-027", "FT-E2E-05"] },
    ],
  },
  {
    id: "module",
    title: "New module",
    e2e: "FT-E2E-06",
    blurb: "One Builder draft on a wide window. Add the workflow step, check it, publish it, and confirm Home can use it.",
    stages: [
      { name: "Draft and publish", ids: ["FT-BLD-002", "FT-BLD-004", "FT-BLD-005", "FT-BLD-050", "FT-WF-034", "FT-BLD-006", "FT-BLD-007", "FT-BLD-008"] },
      { name: "Members see it", ids: ["FT-HOME-003", "FT-HOME-015", "FT-E2E-06"] },
    ],
  },
  {
    id: "year-end",
    title: "Year end",
    e2e: "FT-E2E-07",
    blurb: "An organisation whose financial year starts in April. Pay one donation on 31 March and one on 1 April.",
    stages: [{ name: "Two dates, two years", ids: ["FT-FIN-020", "FT-FIN-005", "FT-REC-115", "FT-E2E-07"] }],
  },
  {
    id: "incident",
    title: "Suspend and restore",
    e2e: "FT-E2E-08",
    blurb: "A disposable organisation. Suspend it, confirm members and the public lookup are refused, then reactivate and sign in again.",
    stages: [
      { name: "Suspend", ids: ["FT-OPC-080", "FT-OPC-083", "FT-OPC-084", "FT-OPC-081", "FT-OPC-082", "FT-AUTH-004"] },
      { name: "Restore", ids: ["FT-OPC-085", "FT-OPC-086", "FT-E2E-08"] },
    ],
  },
  {
    id: "erasure",
    title: "Erase a member",
    e2e: "FT-E2E-09",
    blurb: "One member who has donations. Erase is refused while they are active. Suspend them, erase them, and confirm the money records stay.",
    stages: [
      { name: "Suspend, then erase", ids: ["FT-ADM-028", "FT-PRV-004", "FT-PRV-005", "FT-PRV-006"] },
      { name: "What remains", ids: ["FT-PRV-008", "FT-PRV-009", "FT-PRV-010", "FT-E2E-09"] },
    ],
  },
  {
    id: "integration",
    title: "API key and webhook",
    e2e: "FT-E2E-10",
    blurb: "One key and one connector. Query, create with the same idempotency key, revoke the key, and receive one signed webhook.",
    stages: [
      { name: "Key", ids: ["FT-ADM-080", "FT-ADM-081", "FT-REC-049", "FT-ADM-082"] },
      { name: "Webhook", ids: ["FT-RUN-023", "FT-E2E-10"] },
    ],
  },
  {
    id: "closure",
    title: "Close an organisation",
    e2e: "FT-E2E-11",
    blurb: "A disposable organisation that is already suspended. Close it last. Closed stays closed.",
    stages: [{ name: "Close", ids: ["FT-OPC-087", "FT-OPC-088", "FT-OPC-089", "FT-E2E-11"] }],
  },
  {
    id: "share",
    title: "Share a record",
    e2e: "",
    blurb: "Two people and one restricted record. Share it, change the level, and remove it in the same panel.",
    stages: [{ name: "One record, two people", ids: ["FT-REC-130", "FT-REC-131", "FT-REC-132", "FT-REC-133", "FT-REC-134", "FT-REC-135", "FT-REC-136", "FT-REC-139"] }],
  },
  {
    id: "passkey",
    title: "Passkey sign-in",
    e2e: "",
    blurb: "Pending the passkey branch. One member on one device: turn the policy on, save a passkey, sign in with it, then remove it.",
    stages: [
      { name: "Save", ids: ["FT-PK-001", "FT-PK-002", "FT-PK-003", "FT-PK-004", "FT-PK-005", "FT-PK-006"] },
      { name: "Sign in and remove", ids: ["FT-PK-007", "FT-PK-008", "FT-PK-012", "FT-PK-013"] },
    ],
  },
  {
    id: "shell",
    title: "Shell and Home",
    e2e: "",
    blurb: "One signed-in member. Resize the window, follow a breadcrumb, and pin a list. No second persona.",
    stages: [
      { name: "Resize and move", ids: ["FT-NAV-002", "FT-NAV-003", "FT-NAV-004", "FT-NAV-012", "FT-NAV-015"] },
      { name: "Home", ids: ["FT-HOME-002", "FT-HOME-013"] },
    ],
  },
  {
    id: "rbac",
    title: "Role matrix",
    e2e: "",
    blurb: "Roles belong to the organisation and can change. Sign a member in and note one destination, one field, and one action they can see. Turn that permission off, publish, and confirm those items are gone on the member's next request. Turn it back on, publish, and confirm they return. The published permission decides visibility. The role name does not.",
    stages: [
      {
        name: "Note what the current permission shows",
        ids: [
          "FT-NAV-005", "FT-NAV-007", "FT-HOME-001", "FT-HOME-007", "FT-HOME-010", "FT-HOME-011", "FT-HOME-016", "FT-AUTH-105",
          "FT-ADM-001", "FT-ADM-035", "FT-ADM-040", "FT-REC-004", "FT-REC-026", "FT-REC-109", "FT-REC-111", "FT-REC-112",
          "FT-REC-151", "FT-DON-040", "FT-FIN-030", "FT-WF-004", "FT-WF-021", "FT-WF-025", "FT-WF-030",
        ],
      },
      {
        name: "The organisation changes the permission and publishes",
        ids: ["FT-BLD-070", "FT-BLD-071", "FT-BLD-072", "FT-ADM-053", "FT-BLD-003", "FT-BLD-068", "FT-BLD-069", "FT-BLD-043"],
      },
      {
        name: "The same member's next request follows the new permission",
        ids: ["FT-ADM-026", "FT-AUTH-107", "FT-ADM-027", "FT-REC-186", "FT-REC-202", "FT-REC-204", "FT-REC-229", "FT-FIN-047", "FT-FIN-067", "FT-SEC-009", "FT-ADM-081"],
      },
      {
        name: "A person cannot widen their own access",
        ids: ["FT-ADM-034", "FT-ADM-084", "FT-SEC-008", "FT-ADM-052", "FT-ADM-031", "FT-ADM-033", "FT-ADM-054", "FT-ADM-055", "FT-ADM-056", "FT-AUTH-028", "FT-AUTH-088", "FT-AUTH-103"],
      },
      {
        name: "A share adds access the role does not",
        ids: ["FT-REC-130", "FT-REC-131", "FT-REC-136", "FT-REC-137", "FT-REC-138", "FT-REC-232", "FT-REC-235"],
      },
    ],
  },
];

const knownIds = new Set(
  parsed.areas.flatMap((area) => area.groups.flatMap((group) => group.scenarios.map((scenario) => scenario.id))),
);
const flowMembership = new Map();
const flowWarnings = [];
for (const flow of FLOWS) {
  const seenInFlow = new Set();
  flow.stages.forEach((stage) => {
    stage.ids = stage.ids.filter((id) => {
      if (!knownIds.has(id)) {
        flowWarnings.push(`${flow.id} names ${id}, which is not in the plan`);
        return false;
      }
      if (seenInFlow.has(id)) {
        flowWarnings.push(`${id} is listed twice on ${flow.id}`);
        return false;
      }
      seenInFlow.add(id);
      const membership = flowMembership.get(id) ?? [];
      membership.push({ id: flow.id, name: flow.title, stage: stage.name });
      flowMembership.set(id, membership);
      return true;
    });
  });
}
for (const area of parsed.areas) {
  for (const group of area.groups) {
    for (const scenario of group.scenarios) {
      const membership = flowMembership.get(scenario.id) ?? [];
      const primary = membership[0];
      scenario.flow = primary?.id ?? "";
      scenario.flowName = primary?.name ?? "";
      scenario.flowNames = membership.map((item) => item.name);
      scenario.flows = membership.map((item) => item.id).join(" ");
      scenario.stage = primary?.stage ?? "";
      if (membership.length) {
        scenario.search += ` ${membership.map((item) => `${item.name} ${item.stage}`).join(" ").toLowerCase()}`;
      }
    }
  }
}

const scenarios = parsed.areas.flatMap((area) =>
  area.groups.flatMap((group) => group.scenarios.map((scenario) => ({ ...scenario, area: area.code }))),
);
const flowCount = scenarios.filter((scenario) => scenario.flow).length;
const smokeCount = scenarios.filter((scenario) => scenario.suite === "smoke").length;
const regressionCount = scenarios.length - smokeCount;
const noSmoke = parsed.areas.filter(
  (area) => !area.groups.some((group) => group.scenarios.some((scenario) => scenario.suite === "smoke")),
);

function count(area, suite) {
  return area.groups.reduce(
    (sum, group) => sum + group.scenarios.filter((scenario) => (suite ? scenario.suite === suite : true)).length,
    0,
  );
}

function countPri(area, priority) {
  return area.groups.reduce(
    (sum, group) => sum + group.scenarios.filter((scenario) => scenario.priority === priority).length,
    0,
  );
}

function scenarioHtml(area, group, scenario) {
  const badges = [
    `<span class="badge ${scenario.suite}">${scenario.suite === "smoke" ? "Smoke" : "Regression"}</span>`,
    scenario.priority !== "—" ? `<span class="badge pri ${escapeHtml(scenario.priority.toLowerCase())}">${escapeHtml(scenario.priority)}</span>` : "",
    `<span class="badge type">${escapeHtml(TYPE_LABEL[scenario.type] ?? scenario.type)}</span>`,
    ...(scenario.flowNames ?? []).map((name) => `<span class="badge flow">${escapeHtml(name)}</span>`),
    scenario.pending ? `<span class="badge pending">Pending merge</span>` : "",
  ].join("");
  const steps = scenario.steps.map((step) => `<li>${formatInline(step)}</li>`).join("");
  const expected =
    scenario.expected.length > 1
      ? `<ul>${scenario.expected.map((item) => `<li>${formatInline(item)}</li>`).join("")}</ul>`
      : `<p>${formatInline(scenario.expected[0] ?? "")}</p>`;
  const manual = scenario.manualLinks.length
    ? `<p class="manual">Last manual run, 3–4 Nov 2026: ${scenario.manualLinks
        .map((link) => {
          const defect = link.defects.length ? ` (${link.defects.join(", ")})` : "";
          const result = link.result ? ` ${link.result}${defect}` : "";
          const title = link.note ? ` title="${escapeHtml(link.note)}"` : "";
          return `<span${title}>${escapeHtml(link.id)}${escapeHtml(result)}</span>`;
        })
        .join(" · ")}</p>`
    : "";
  const pending = scenario.pending
    ? `<p class="pending-note">Run this only after <code>features/passkey-authentication</code> has merged.</p>`
    : "";
  return `<details class="scenario" id="${escapeHtml(scenario.id)}" data-area="${area.code}" data-group="${escapeHtml(group.name)}" data-suite="${scenario.suite}" data-pri="${escapeHtml(scenario.priority)}" data-type="${escapeHtml(scenario.type)}" data-flow="${escapeHtml(scenario.flow)}" data-flows="${escapeHtml(scenario.flows)}" data-search="${escapeHtml(scenario.search)}">
  <summary><span class="sid">${escapeHtml(scenario.id)}</span>${badges}<span class="stitle">${formatInline(scenario.title)}</span></summary>
  <div class="body">
    ${pending}
    <h4>Steps</h4>
    <ol>${steps}</ol>
    <h4>Expected</h4>
    ${expected}
    ${manual}
  </div>
</details>`;
}

function groupHtml(area, group) {
  const setup = group.setup ? `<p class="setup">${formatInline(group.setup)}</p>` : "";
  const cards = group.scenarios.map((scenario) => scenarioHtml(area, group, scenario)).join("\n");
  const smoke = group.scenarios.filter((scenario) => scenario.suite === "smoke").length;
  const regression = group.scenarios.length - smoke;
  const head =
    group.name === "Main"
      ? ""
      : `<div class="group-head">
    <h3>${escapeHtml(group.name)}</h3>
    <p class="group-count"><span>${smoke} smoke</span><span>${regression} regression</span><span>${group.scenarios.length} scenarios</span></p>
  </div>`;
  return `<section class="group" data-area="${area.code}" data-group="${escapeHtml(group.name)}">
  ${head}
  ${setup}
  ${cards}
</section>`;
}

function areaHtml(area) {
  const intro = area.intro ? `<p class="area-intro">${formatInline(area.intro)}</p>` : "";
  return `<section class="area" id="area-${area.code}" data-area="${area.code}">
  <div class="area-head">
    <h2>${escapeHtml(area.name)}</h2>
    <p>${escapeHtml(area.code)} · ${count(area)} scenarios · ${count(area, "smoke")} smoke · ${count(area, "regression")} regression</p>
  </div>
  ${intro}
  ${area.groups.map((group) => groupHtml(area, group)).join("\n")}
</section>`;
}

const matrixRows = parsed.areas
  .map((area) => {
    const smoke = count(area, "smoke");
    const regression = count(area, "regression");
    const total = smoke + regression;
    return `<tr data-area="${area.code}">
  <th scope="row"><button type="button" data-area="${area.code}" data-suite="all">${escapeHtml(area.name)}</button><span class="code">${area.code}</span></th>
  <td><button type="button" class="count smoke" data-area="${area.code}" data-suite="smoke">${smoke}</button></td>
  <td><button type="button" class="count regression" data-area="${area.code}" data-suite="regression">${regression}</button></td>
  <td><button type="button" class="count total" data-area="${area.code}" data-suite="all">${total}</button></td>
  <td>${countPri(area, "P0")}</td>
  <td>${countPri(area, "P1")}</td>
  <td>${countPri(area, "P2")}</td>
</tr>`;
  })
  .join("\n");

const areaChips = parsed.areas
  .map(
    (area) =>
      `<button type="button" class="chip" data-area="${area.code}" data-suite="all">${escapeHtml(area.name)} <span>${count(area)}</span></button>`,
  )
  .join("");

const types = [...new Set(scenarios.map((scenario) => scenario.type))].sort();
const typeOptions = types
  .map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(TYPE_LABEL[type] ?? type)}</option>`)
  .join("");

const whenRows = WHEN.map(([trigger, run]) => `<tr><td>${escapeHtml(trigger)}</td><td>${escapeHtml(run)}</td></tr>`).join("");

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OneNGO test plan</title>
  <meta name="description" content="Coverage matrix for OneNGO smoke and regression scenarios, with steps for each scenario." />
  <style>
    :root {
      --fg: #1d2733;
      --muted: #5b6878;
      --line: #d8dee6;
      --bg: #f5f7fa;
      --card: #fff;
      --brand: #1f5f8b;
      --brand-fg: #fff;
      --ok: #1d7a46;
      --warn: #9a6200;
      --bad: #b3261e;
      --radius: 6px;
      --font: "Segoe UI", Roboto, "Noto Sans", "Noto Sans Devanagari", Helvetica, Arial, sans-serif;
      --font-mono: Consolas, "Cascadia Mono", "Courier New", monospace;
      --body-size: 14px;
      --title-size: 1.15rem;
      --card-border: rgba(148, 163, 184, .25);
      --card-radius: 14px;
      --card-shadow: 0 1px 2px #0f172a0a;
      --panel-border: rgba(148, 163, 184, .22);
      --panel-radius: 16px;
      --panel-shadow: 0 1px 2px #0f172a0d, 0 4px 14px #0f172a12;
      --divider: rgba(148, 163, 184, .2);
      --field-height: 40px;
      --field-radius: 4px;
      --field-border: #79747e;
      --focus-ring: 2px solid var(--brand);
      --th-bg: #f8fafc;
      --th-fg: #64748b;
      --row-line: rgba(148, 163, 184, .18);
      --badge-bg: #e8edf3;
      --notice-info-bg: #eef5fb;
      --notice-info-border: #c6d9e8;
      --notice-ok-bg: #eef9f2;
      --notice-error-bg: #fdf0ef;
      --notice-error-border: #efc4c1;
      --section-bg: color-mix(in srgb, var(--brand) 12%, #fff);
      --row-hover: color-mix(in srgb, var(--brand) 8%, #fff);
      --search-border: rgba(148, 163, 184, .35);
      --search-radius: 12px;
      --ok-bg: #e3f4ea;
      --warn-bg: #fdf1dc;
      --content-max: 1180px;
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      color: var(--fg);
      background: var(--bg);
      font: var(--body-size)/1.45 var(--font);
      -webkit-font-smoothing: antialiased;
    }
    a { color: var(--brand); }
    :focus-visible { outline: var(--focus-ring); outline-offset: 2px; }
    .skip { position: absolute; left: 12px; top: -40px; background: var(--brand); color: var(--brand-fg); padding: 8px 12px; z-index: 6; }
    .skip:focus { top: 12px; }
    .app-bar {
      position: sticky;
      top: 0;
      z-index: 4;
      height: 56px;
      display: flex;
      align-items: center;
      padding: 0 16px;
      background: var(--brand);
      color: var(--brand-fg);
    }
    .app-bar__brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .app-bar__product { font-size: 1rem; font-weight: 700; }
    .app-bar__org {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      padding-inline-start: 10px;
      border-inline-start: 1px solid rgba(255, 255, 255, .35);
      font-size: .95rem;
      font-weight: 600;
    }
    main { max-width: var(--content-max); margin: 0 auto; padding: 16px 16px 64px; }
    .page-head { margin-bottom: 14px; }
    h1 { margin: 0 0 6px; font-size: var(--title-size); font-weight: 700; }
    h2 { margin: 0 0 8px; font-size: 1rem; font-weight: 700; }
    .lede, .panel p, .area-intro, .setup, .area-head p, .group-count, .manual, .pending-note { color: var(--muted); }
    .lede { margin: 0; max-width: 46rem; }
    .stats { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
    .stat {
      background: var(--card);
      border: 1px solid var(--card-border);
      border-radius: var(--card-radius);
      box-shadow: var(--card-shadow);
      padding: 8px 12px;
      min-width: 7rem;
    }
    .stat b { display: block; color: var(--brand); font-size: var(--title-size); font-weight: 700; }
    .stat span { color: var(--muted); font-size: .75rem; }
    section.panel, .filters, .matrix-wrap, .area {
      background: var(--card);
      border: 1px solid var(--panel-border);
      border-radius: var(--panel-radius);
      box-shadow: var(--panel-shadow);
    }
    section.panel, .matrix-wrap { padding: 14px 14px 6px; margin: 0 0 14px; }
    table { width: 100%; border-collapse: collapse; background: var(--card); }
    th, td { padding: 10px 12px; border-bottom: 1px solid var(--row-line); vertical-align: top; text-align: left; font-size: .76rem; }
    th { font-size: .64rem; color: var(--th-fg); font-weight: 700; letter-spacing: .03em; text-transform: uppercase; background: var(--th-bg); }
    .matrix td, .matrix th { text-align: right; }
    .matrix th:first-child, .matrix td:first-child, .matrix tfoot th { text-align: left; }
    .matrix tbody tr.selected { background: var(--row-hover); }
    button, select, input { font: inherit; color: inherit; }
    button { cursor: pointer; }
    .matrix button, .text-btn { background: none; border: 0; }
    .matrix th button, .matrix td button.count { font-weight: 700; }
    .matrix th button { color: var(--brand); padding: 0; text-align: left; }
    .code { display: block; color: var(--muted); font-family: var(--font-mono); font-size: .72rem; font-weight: 500; text-transform: none; letter-spacing: 0; }
    .count { min-width: 2.4rem; border-radius: 999px; padding: 4px 8px; font-size: .72rem; line-height: 1; }
    .count.smoke { background: var(--section-bg); color: var(--brand); }
    .count.regression { background: var(--warn-bg); color: var(--warn); }
    .count.total { background: var(--badge-bg); color: var(--muted); }
    .filters {
      position: sticky;
      top: 56px;
      z-index: 3;
      padding: 12px;
      margin: 0 0 14px;
      display: grid;
      gap: 10px;
    }
    .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .seg { display: flex; flex-wrap: wrap; gap: 8px; }
    .seg button, .chip {
      border: 1px solid var(--search-border);
      background: #fff;
      color: #475569;
      border-radius: 999px;
      padding: 8px 14px;
      font-size: .72rem;
      font-weight: 700;
      line-height: 1;
      white-space: nowrap;
    }
    .seg button:hover, .chip:hover { border-color: color-mix(in srgb, var(--brand) 25%, #fff); color: var(--brand); background: color-mix(in srgb, var(--brand) 6%, #fff); }
    .seg button[aria-pressed="true"], .chip[aria-pressed="true"] { background: var(--brand); border-color: var(--brand); color: var(--brand-fg); }
    input[type="search"], select {
      min-height: var(--field-height);
      border: 1px solid var(--field-border);
      background: #fff;
      border-radius: var(--field-radius);
      padding: 0 12px;
      font-size: .85rem;
    }
    input[type="search"] { min-width: min(100%, 280px); border-radius: var(--search-radius); border-color: var(--search-border); }
    .chips { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 2px; scrollbar-width: none; }
    .chips::-webkit-scrollbar { display: none; }
    .chip span { font-weight: 600; }
    .subhead { margin: 0 0 10px; display: flex; justify-content: space-between; gap: 12px; align-items: end; }
    .text-btn { color: var(--brand); font-weight: 600; text-decoration: underline; text-underline-offset: 2px; padding: 2px 4px; }
    .area { margin: 0 0 14px; padding: 4px 14px 14px; }
    .area-head, .group-head { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; flex-wrap: wrap; }
    .area-head { padding-top: 12px; }
    .group { margin-top: 8px; }
    .group h3 { margin: 14px 0 6px; font-size: .9rem; font-weight: 700; }
    .group-count { display: flex; gap: 10px; margin: 0; font-size: .75rem; }
    .scenario { border-top: 1px solid var(--divider); padding: 8px 0; }
    .scenario summary { cursor: pointer; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .scenario summary::-webkit-details-marker { display: none; }
    .scenario summary:hover { background: var(--row-hover); }
    .sid { font-family: var(--font-mono); font-size: .78rem; font-weight: 700; }
    .stitle { flex: 1 0 16rem; }
    .badge {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 999px;
      font-size: .56rem;
      font-weight: 700;
      letter-spacing: .02em;
      text-transform: uppercase;
      line-height: 1;
      background: var(--badge-bg);
      color: var(--muted);
    }
    .badge.smoke { background: var(--section-bg); color: var(--brand); }
    .badge.regression { background: var(--warn-bg); color: var(--warn); }
    .badge.p0 { background: var(--notice-error-bg); color: var(--bad); }
    .badge.p1 { background: var(--warn-bg); color: var(--warn); }
    .badge.type { background: var(--notice-info-bg); color: var(--brand); }
    .badge.pending { background: var(--notice-error-bg); color: var(--bad); }
    .badge.flow { background: var(--section-bg); color: var(--brand); text-transform: none; letter-spacing: 0; font-size: .68rem; }
    .flow-blurb { margin: 0 0 12px; color: var(--muted); }
    .flow-stage { margin: 0 0 22px; }
    .flow-stage > h3 { margin: 0 0 8px; font-size: .95rem; }
    .body { padding: 4px 0 8px 18px; }
    .body h4 { margin: 12px 0 4px; font-size: .68rem; letter-spacing: .03em; text-transform: uppercase; color: var(--brand); }
    .body ol, .body ul { margin: 0; padding-left: 1.2rem; }
    .body li { margin: 4px 0; }
    .manual, .pending-note { font-size: .85rem; }
    code { font-family: var(--font-mono); font-size: .9em; }
    .gap {
      color: var(--warn);
      background: var(--warn-bg);
      border: 1px solid #ead7a8;
      border-radius: 12px;
      padding: 9px 12px;
      font-size: .78rem;
    }
    @media (max-width: 800px) {
      .matrix-wrap { overflow-x: auto; }
      .body { padding-left: 0; }
      .seg button, .chip { min-height: 44px; display: inline-flex; align-items: center; }
    }
    @media print {
      .app-bar { position: static; background: #fff; color: #000; border-bottom: 1px solid #ccc; }
      .filters, .skip, .text-btn { display: none !important; }
      .scenario { page-break-inside: avoid; }
      .scenario .body { display: block; }
      .area, .matrix-wrap, section.panel, .stat { box-shadow: none; }
    }
  </style>
</head>
<body>
  <a class="skip" href="#scenarios">Skip to scenarios</a>
  <header class="app-bar">
    <div class="app-bar__brand">
      <span class="app-bar__product">OneNGO</span>
      <span class="app-bar__org">Test plan</span>
    </div>
  </header>
  <main>
    <section class="page-head">
      <h1>Test plan</h1>
      <p class="lede">Each area lists the scenarios it covers. A single-sitting flow is a path one person can walk in order, on the same session and the same data. Smoke is the release gate. Every other scenario is regression.</p>
      <div class="stats">
        <div class="stat"><b>${parsed.areas.length}</b><span>Areas</span></div>
        <div class="stat"><b>${scenarios.length}</b><span>Scenarios</span></div>
        <div class="stat"><b>${smokeCount}</b><span>Smoke</span></div>
        <div class="stat"><b>${regressionCount}</b><span>Regression</span></div>
        <div class="stat"><b>${FLOWS.length}</b><span>Single-sitting flows</span></div>
        <div class="stat"><b>${scenarios.length - flowCount}</b><span>Need their own setup</span></div>
      </div>
    </section>
    <section class="panel">
      <h2>How to read this</h2>
      <p>Smoke comes from the release gate in the functional test plan. A failing P0 smoke scenario stops the release candidate. Regression is every other scenario in that plan, including P2. On a release candidate, run smoke first, then every P0 and P1 scenario. Close and suspend scenarios need a disposable organisation.</p>
      <p>${flowCount} scenarios sit on a single-sitting flow. The badge on a scenario names that flow. Role matrix checks prove that visibility follows the permission the organisation last published: turn it off and the destination, field, or action disappears on the next request, then turn it back on and it returns. Choosing a flow lists its scenarios in the order to run them. The other ${scenarios.length - flowCount} need a different person, organisation, or harness, so they stay in their area.</p>
      <p>Source: <a href="functional-test-plan.md">functional test plan</a>, section 34, and the <a href="manual-test-plan.md">manual test plan</a> where a scenario cites an MT id. Local app <code>http://localhost:4200</code>, API <code>http://localhost:8080</code>. Personas and the Riverbank request are in the functional plan, section 7.</p>
      <div class="gap"><strong>No smoke scenario:</strong> ${noSmoke.map((area) => escapeHtml(area.name)).join(", ")}.</div>
      <h2>What to run when</h2>
      <table>
        <thead><tr><th>Change</th><th>Run</th></tr></thead>
        <tbody>${whenRows}</tbody>
      </table>
    </section>

    <div class="filters">
      <div class="row">
        <input id="q" type="search" placeholder="Search id, step, or expected result" aria-label="Search scenarios" />
        <div class="seg" role="group" aria-label="Suite">
          <button type="button" data-suite="all" aria-pressed="true">All</button>
          <button type="button" data-suite="smoke" aria-pressed="false">Smoke</button>
          <button type="button" data-suite="regression" aria-pressed="false">Regression</button>
          <button type="button" data-suite="release" aria-pressed="false">Release candidate</button>
        </div>
        <select id="pri" aria-label="Priority">
          <option value="all">All priorities</option>
          <option value="P0">P0</option>
          <option value="P1">P1</option>
          <option value="P2">P2</option>
        </select>
        <select id="type" aria-label="Scenario type">
          <option value="all">All types</option>
          ${typeOptions}
        </select>
        <button type="button" class="text-btn" id="clear">Clear filters</button>
      </div>
      <div class="chips" id="areas" role="group" aria-label="Area">
        <button type="button" class="chip" data-area="all" data-suite="all" aria-pressed="true">All areas</button>
        ${areaChips}
      </div>
      <div class="chips" id="groups" role="group" aria-label="Scenario group" hidden></div>
      <div class="chips" id="flows" role="group" aria-label="Single sitting flow"></div>
    </div>

    <div class="matrix-wrap">
      <h2>Coverage matrix</h2>
      <p>Choose an area, or choose its smoke or regression count, to list only those scenarios.</p>
      <table class="matrix">
        <thead>
          <tr><th>Area</th><th>Smoke</th><th>Regression</th><th>Total</th><th>P0</th><th>P1</th><th>P2</th></tr>
        </thead>
        <tbody>${matrixRows}</tbody>
        <tfoot>
          <tr><th scope="row">All areas</th><td>${smokeCount}</td><td>${regressionCount}</td><td>${scenarios.length}</td><td>${scenarios.filter((s) => s.priority === "P0").length}</td><td>${scenarios.filter((s) => s.priority === "P1").length}</td><td>${scenarios.filter((s) => s.priority === "P2").length}</td></tr>
        </tfoot>
      </table>
    </div>

    <div class="subhead" id="scenarios">
      <div>
        <h2>Scenarios</h2>
        <p id="showing"></p>
        <p class="flow-blurb" id="flow-blurb" hidden></p>
      </div>
      <div class="row">
        <button type="button" class="text-btn" id="expand">Expand visible</button>
        <button type="button" class="text-btn" id="collapse">Collapse</button>
      </div>
    </div>
    <div id="flow-run" hidden></div>
    ${parsed.areas.map(areaHtml).join("\n")}
  </main>
  <script>
    const FLOWS = ${JSON.stringify(FLOWS.map((flow) => ({ id: flow.id, title: flow.title, e2e: flow.e2e, blurb: flow.blurb, stages: flow.stages.map((stage) => ({ name: stage.name, ids: stage.ids })) })))};
    const state = { area: "all", group: "all", flow: "all", suite: "all", pri: "all", type: "all", q: "" };
    const slot = new Map();
    const q = document.getElementById("q");
    const pri = document.getElementById("pri");
    const type = document.getElementById("type");
    const groups = document.getElementById("groups");
    const showing = document.getElementById("showing");

    const flowHost = document.getElementById("flow-run");
    const flowBlurb = document.getElementById("flow-blurb");
    const flowChips = document.getElementById("flows");

    function readHash() {
      const params = new URLSearchParams(location.hash.replace(/^#/, ""));
      state.area = params.get("area") || "all";
      state.group = params.get("group") || "all";
      const requested = params.get("flow") || "all";
      state.flow = FLOWS.some((flow) => flow.id === requested) ? requested : "all";
      state.suite = params.get("suite") || "all";
      state.pri = params.get("pri") || "all";
      state.type = params.get("type") || "all";
      state.q = params.get("q") || "";
      q.value = state.q;
      pri.value = ["P0", "P1", "P2"].includes(state.pri) ? state.pri : "all";
      type.value = [...type.options].some((option) => option.value === state.type) ? state.type : "all";
      state.pri = pri.value;
      state.type = type.value;
    }

    function writeHash() {
      const params = new URLSearchParams();
      if (state.area !== "all") params.set("area", state.area);
      if (state.group !== "all") params.set("group", state.group);
      if (state.flow !== "all") params.set("flow", state.flow);
      if (state.suite !== "all") params.set("suite", state.suite);
      if (state.pri !== "all") params.set("pri", state.pri);
      if (state.type !== "all") params.set("type", state.type);
      if (state.q) params.set("q", state.q);
      const next = params.toString();
      history.replaceState(null, "", next ? "#" + next : location.pathname);
    }

    function matches(el) {
      if (state.area !== "all" && el.dataset.area !== state.area) return false;
      if (state.flow !== "all" && !(el.dataset.flows || "").split(" ").includes(state.flow)) return false;
      if (state.group !== "all" && el.dataset.group !== state.group) return false;
      if (state.suite === "smoke" && el.dataset.suite !== "smoke") return false;
      if (state.suite === "regression" && el.dataset.suite !== "regression") return false;
      if (state.suite === "release" && !(el.dataset.suite === "smoke" || el.dataset.pri === "P0" || el.dataset.pri === "P1")) return false;
      if (state.pri !== "all" && el.dataset.pri !== state.pri) return false;
      if (state.type !== "all" && el.dataset.type !== state.type) return false;
      if (state.q && !el.dataset.search.includes(state.q.toLowerCase())) return false;
      return true;
    }

    function remember(el) {
      if (slot.has(el)) return;
      const mark = document.createComment("flow-slot");
      el.parentNode.insertBefore(mark, el);
      slot.set(el, mark);
    }

    function restore() {
      for (const el of [...flowHost.querySelectorAll(".scenario")]) {
        const mark = slot.get(el);
        if (mark && mark.parentNode) mark.parentNode.insertBefore(el, mark);
        if (mark) mark.remove();
        slot.delete(el);
      }
      flowHost.replaceChildren();
      flowHost.hidden = true;
    }

    function showFlow(flow) {
      restore();
      flowHost.hidden = false;
      flow.stages.forEach((stage) => {
        const section = document.createElement("section");
        section.className = "flow-stage";
        const heading = document.createElement("h3");
        heading.textContent = stage.name;
        section.append(heading);
        stage.ids.forEach((id) => {
          const el = document.getElementById(id);
          if (!el) return;
          remember(el);
          section.append(el);
        });
        flowHost.append(section);
      });
    }

    function countForFlow(id) {
      const saved = state.flow;
      state.flow = id;
      const count = [...document.querySelectorAll(".scenario")].filter(matches).length;
      state.flow = saved;
      return count;
    }

    function renderFlows() {
      flowChips.innerHTML = "";
      const all = document.createElement("button");
      all.type = "button";
      all.className = "chip";
      all.dataset.flow = "all";
      all.textContent = "All scenarios";
      all.setAttribute("aria-pressed", state.flow === "all" ? "true" : "false");
      flowChips.append(all);
      FLOWS.forEach((flow) => {
        const count = countForFlow(flow.id);
        if (count === 0) return;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "chip";
        button.dataset.flow = flow.id;
        button.textContent = flow.title + " (" + count + ")";
        button.setAttribute("aria-pressed", state.flow === flow.id ? "true" : "false");
        flowChips.append(button);
      });
    }

    function renderGroups() {
      groups.innerHTML = "";
      if (state.area === "all" || state.flow !== "all") {
        groups.hidden = true;
        return;
      }
      const names = [...new Set([...document.querySelectorAll(".scenario")].filter((el) => el.dataset.area === state.area).map((el) => el.dataset.group))];
      const savedGroup = state.group;
      state.group = "all";
      const named = names.map((name) => ({
        name,
        count: [...document.querySelectorAll(".scenario")].filter((el) => el.dataset.area === state.area && el.dataset.group === name && matches(el)).length,
      })).filter((item) => item.count > 0);
      state.group = savedGroup;
      if (named.length < 2) {
        groups.hidden = true;
        return;
      }
      const all = document.createElement("button");
      all.type = "button";
      all.className = "chip";
      all.textContent = "All groups in this area";
      all.setAttribute("aria-pressed", state.group === "all" ? "true" : "false");
      all.addEventListener("click", () => { state.group = "all"; apply(); });
      groups.append(all);
      named.forEach((item) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "chip";
        button.dataset.group = item.name;
        button.textContent = item.name + " (" + item.count + ")";
        button.setAttribute("aria-pressed", state.group === item.name ? "true" : "false");
        button.addEventListener("click", () => { state.group = item.name; apply(); });
        groups.append(button);
      });
      groups.hidden = false;
    }

    function apply() {
      if (state.flow !== "all" && countForFlow(state.flow) === 0) state.flow = "all";
      if (state.area !== "all" && state.group !== "all") {
        const savedGroup = state.group;
        state.group = "all";
        const stillThere = [...document.querySelectorAll(".scenario")].some((el) => el.dataset.area === state.area && el.dataset.group === savedGroup && matches(el));
        state.group = stillThere ? savedGroup : "all";
      }
      const flow = FLOWS.find((item) => item.id === state.flow);
      if (flow) {
        showFlow(flow);
        flowBlurb.hidden = false;
        flowBlurb.textContent = flow.blurb + (flow.e2e ? " Covers " + flow.e2e + "." : "");
      } else {
        restore();
        flowBlurb.hidden = true;
      }
      let shown = 0;
      document.querySelectorAll(".scenario").forEach((el) => {
        const ok = matches(el);
        el.hidden = !ok;
        if (ok) shown += 1;
      });
      document.querySelectorAll(".group").forEach((group) => {
        group.hidden = ![...group.querySelectorAll(".scenario")].some((el) => !el.hidden);
      });
      document.querySelectorAll(".area").forEach((area) => {
        area.hidden = ![...area.querySelectorAll(".scenario")].some((el) => !el.hidden);
      });
      document.querySelectorAll(".flow-stage").forEach((stage) => {
        stage.hidden = ![...stage.querySelectorAll(".scenario")].some((el) => !el.hidden);
      });
      document.querySelectorAll("[data-suite]").forEach((button) => {
        if (button.classList.contains("chip") || button.closest(".seg")) {
          const pressed = (button.dataset.suite ? button.dataset.suite === state.suite || (button.dataset.suite === "all" && state.suite === "all" && button.dataset.area === state.area) : false);
          if (button.closest(".seg")) button.setAttribute("aria-pressed", button.dataset.suite === state.suite ? "true" : "false");
        }
      });
      document.querySelectorAll("#areas .chip").forEach((chip) => {
        chip.setAttribute("aria-pressed", chip.dataset.area === state.area ? "true" : "false");
      });
      document.querySelectorAll(".matrix tbody tr").forEach((row) => {
        row.classList.toggle("selected", row.dataset.area === state.area);
      });
      const label = state.suite === "release" ? "release-candidate" : state.suite === "all" ? "" : state.suite + " ";
      const where = flow ? " in " + flow.title + ", in run order" : "";
      showing.textContent = "Showing " + shown + " " + label + "scenario" + (shown === 1 ? "" : "s") + where + ".";
      renderGroups();
      renderFlows();
      writeHash();
    }

    document.getElementById("areas").addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      state.area = button.dataset.area;
      state.group = "all";
      apply();
      document.getElementById("scenarios").scrollIntoView({ behavior: "smooth", block: "start" });
    });
    document.querySelector(".matrix").addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      state.area = button.dataset.area;
      state.group = "all";
      if (button.dataset.suite) state.suite = button.dataset.suite;
      apply();
      document.getElementById("scenarios").scrollIntoView({ behavior: "smooth", block: "start" });
    });
    document.querySelector(".seg").addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      state.suite = button.dataset.suite;
      apply();
    });
    q.addEventListener("input", () => { state.q = q.value.trim(); apply(); });
    pri.addEventListener("change", () => { state.pri = pri.value; apply(); });
    type.addEventListener("change", () => { state.type = type.value; apply(); });
    flowChips.addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      state.flow = button.dataset.flow;
      state.group = "all";
      apply();
      document.getElementById("scenarios").scrollIntoView({ behavior: "smooth", block: "start" });
    });
    document.getElementById("clear").addEventListener("click", () => {
      state.area = "all"; state.group = "all"; state.flow = "all"; state.suite = "all"; state.pri = "all"; state.type = "all"; state.q = "";
      q.value = ""; pri.value = "all"; type.value = "all";
      apply();
    });
    document.getElementById("expand").addEventListener("click", () => {
      document.querySelectorAll(".scenario:not([hidden])").forEach((el) => { el.open = true; });
    });
    document.getElementById("collapse").addEventListener("click", () => {
      document.querySelectorAll(".scenario").forEach((el) => { el.open = false; });
    });
    readHash();
    apply();
  </script>
</body>
</html>
`;

const out = path.join(dir, "test-plan.html");
fs.writeFileSync(out, html);
console.log(`areas ${parsed.areas.length}`);
console.log(`scenarios ${scenarios.length}`);
console.log(`smoke ${smokeCount}`);
console.log(`regression ${regressionCount}`);
const rbacCount = scenarios.filter((scenario) => scenario.flows.split(" ").includes("rbac")).length;
console.log(`on a flow ${flowCount}`);
console.log(`rbac ${rbacCount}`);
console.log(`standalone ${scenarios.length - flowCount}`);
console.log(`flow warnings ${flowWarnings.length}`);
flowWarnings.forEach((warning) => console.log("FLOW " + warning));
console.log(`no smoke ${noSmoke.map((area) => area.code).join(",")}`);
console.log(`missing smoke ${missingSmoke.join(",") || "none"}`);
const seen = new Map();
for (const scenario of scenarios) {
  seen.set(scenario.id, (seen.get(scenario.id) ?? 0) + 1);
}
const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([id, n]) => `${id}x${n}`);
console.log(`dupes ${dupes.join(",") || "none"}`);
console.log(`warnings ${parsed.warnings.length}`);
parsed.warnings.slice(0, 12).forEach((warning) => console.log("WARN " + warning));
console.log(`wrote ${out} (${html.length} bytes)`);
