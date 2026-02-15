 VocabSRS: offline iPhone PWA, JSON-in-localStorage, Anki-lite scheduling */

const STORAGE_KEY = "vocabsrs_cards_v1";

function nowMs() { return Date.now(); }
function daysToMs(d) { return d * 24 * 60 * 60 * 1000; }
function uid() { return crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2); }

function loadCards() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}
function saveCards(cards) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cards));
}

function seedIfEmpty() {
  const cards = loadCards();
  if (cards.length > 0) return;

  const seeded = [
    makeCard("to achieve", "достичь / достигать", "Он достиг своей цели."),
    makeCard("to remember", "помнить / вспомнить", "Я не могу вспомнить её имя.")
  ];
  saveCards(seeded);
}

function makeCard(english, russian, example) {
  return {
    id: uid(),
    english: (english || "").trim(),
    russian: (russian || "").trim(),
    example: (example || "").trim(),

    // SRS
    dueAt: nowMs(),        // due now
    intervalDays: 0,
    ease: 2.5,
    reps: 0
  };
}

function dueCards(cards) {
  const t = nowMs();
  return cards.filter(c => (c.dueAt || 0) <= t).sort((a,b)=> (a.dueAt||0)-(b.dueAt||0));
}

function updateHeader() {
  const cards = loadCards();
  document.getElementById("totalCount").textContent = cards.length;
  document.getElementById("dueCount").textContent = dueCards(cards).length;

  const badge = document.getElementById("offlineBadge");
  const online = navigator.onLine;
  badge.textContent = online ? "Online (data stays on device)" : "Offline ✔︎";
  badge.className = "tiny " + (online ? "muted" : "ok");
}

/* Anki-lite (SM-2-ish) */
function applyGrade(card, grade) {
  const quality = ({ again: 1, hard: 3, good: 4, easy: 5 })[grade];
  const t = nowMs();

  if (quality < 3) {
    card.reps = 0;
    card.intervalDays = 0;
    card.dueAt = t + 10 * 60 * 1000; // 10 minutes
    return;
  }

  card.reps = (card.reps || 0) + 1;

  const q = quality;
  const ef = (card.ease ?? 2.5) + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  card.ease = Math.max(1.3, ef);

  if (card.reps === 1) card.intervalDays = 1;
  else if (card.reps === 2) card.intervalDays = 3;
  else card.intervalDays = Math.max(1, (card.intervalDays || 1) * card.ease);

  if (grade === "hard") card.intervalDays = Math.max(1, card.intervalDays * 0.75);
  if (grade === "easy") card.intervalDays = card.intervalDays * 1.15;

  card.dueAt = t + daysToMs(card.intervalDays);
}

/* CSV parse/export */
function parseCSV(text) {
  const rows = [];
  let row = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '"' && inQuotes && next === '"') { cur += '"'; i++; continue; }
    if (ch === '"') { inQuotes = !inQuotes; continue; }

    if (!inQuotes && ch === ",") { row.push(cur); cur = ""; continue; }
    if (!inQuotes && ch === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; continue; }
    if (ch !== "\r") cur += ch;
  }
  row.push(cur);
  rows.push(row);
  if (rows.length && rows[rows.length-1].every(c => String(c).trim() === "")) rows.pop();
  return rows;
}

function toCSV(cards) {
  const header = ["english","russian","example"].join(",");
  const esc = (s) => {
    const x = String(s ?? "");
    if (/[,"\n]/.test(x)) return `"${x.replaceAll('"','""')}"`;
    return x;
  };
  const lines = cards.map(c => [esc(c.english), esc(c.russian), esc(c.example)].join(","));
  return [header, ...lines].join("\n");
}

function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
}

/* Views */
const view = document.getElementById("view");
let activeTab = "review";

/* Review state */
let reviewDirection = "enToRu"; // or ruToEn
let showAnswer = false;
let currentId = null;

let reviewMode = "flip"; // "flip" or "type"
let typingState = { text: "", checked: false };

function resetRevealAndTyping() {
  showAnswer = false;
  typingState = { text: "", checked: false };
}

function render() {
  updateHeader();

  const cards = loadCards();
  if (activeTab === "review") return renderReview(cards);
  if (activeTab === "add") return renderAdd();
  if (activeTab === "cards") return renderCards(cards);
  if (activeTab === "import") return renderImportExport(cards);
}

function renderReview(cards) {
  const due = dueCards(cards);
  const current = pickCurrent(due);

  // Enforce: Type mode is only EN → RU (no typing English)
  if (reviewMode === "type") {
    reviewDirection = "enToRu";
  }

  view.innerHTML = `
    <div class="card">
      <div class="row">
        <div class="big">Review</div>
        <div class="spacer"></div>
        <div id="dirWrap"></div>
      </div>

      <div class="row" style="margin-top:10px;">
        <label style="margin:0; color:#a1a1aa;">Mode</label>
        <div class="spacer"></div>
        <select id="mode">
          <option value="flip">Flip (tap to reveal)</option>
          <option value="type">Type (strong recall)</option>
        </select>
      </div>

      <div class="tiny muted" style="margin-top:8px;">
        Type mode: English prompt → you type Russian → Check → grade yourself.
      </div>

      <div style="margin-top:14px;" id="cardArea"></div>
      <div style="margin-top:14px;" class="row" id="buttons"></div>
    </div>
  `;

  const dirWrap = document.getElementById("dirWrap");
  if (reviewMode === "flip") {
    dirWrap.innerHTML = `
      <select id="dir">
        <option value="enToRu">EN → RU</option>
        <option value="ruToEn">RU → EN</option>
      </select>
    `;
    const dirSel = document.getElementById("dir");
    dirSel.value = reviewDirection;
    dirSel.addEventListener("change", () => {
      reviewDirection = dirSel.value;
      resetRevealAndTyping();
      render();
    });
  } else {
    dirWrap.innerHTML = `<div class="tiny muted">Direction: EN → RU (Type mode)</div>`;
  }

  const modeSel = document.getElementById("mode");
  modeSel.value = reviewMode;
  modeSel.addEventListener("change", () => { reviewMode = modeSel.value; resetRevealAndTyping(); render(); });

  const cardArea = document.getElementById("cardArea");
  const buttons = document.getElementById("buttons");

  if (!current) {
    cardArea.innerHTML = `<div class="big">Nothing due 🎉</div><div class="muted" style="margin-top:8px;">Add words or wait until some become due.</div>`;
    buttons.innerHTML = ``;
    return;
  }

  currentId = current.id;

  const prompt = reviewDirection === "enToRu" ? current.english : current.russian;
  const answer = reviewDirection === "enToRu" ? current.russian : current.english;

  if (reviewMode === "flip") {
    cardArea.innerHTML = `
      <div class="card" id="flash" style="cursor:pointer;">
        <div class="big">${escapeHtml(prompt)}</div>
        ${showAnswer ? `
          <hr style="border:0;border-top:1px solid #222;margin:14px 0;">
          <div class="big" style="font-size:20px;">${escapeHtml(answer)}</div>
          ${current.example ? `<div style="margin-top:10px;" class="muted">${escapeHtml(current.example)}</div>` : ``}
        ` : `<div class="muted" style="margin-top:10px;">Tap to reveal</div>`}
        <div class="tiny muted" style="margin-top:12px;">
          reps: ${current.reps ?? 0} • interval: ${(current.intervalDays ?? 0).toFixed(1)}d • ease: ${(current.ease ?? 2.5).toFixed(2)}
        </div>
      </div>
    `;

    document.getElementById("flash").onclick = () => { showAnswer = !showAnswer; render(); };

    buttons.innerHTML = `
      <button class="btn again" ${showAnswer ? "" : "disabled"} data-g="again">Again</button>
      <button class="btn hard"  ${showAnswer ? "" : "disabled"} data-g="hard">Hard</button>
      <button class="btn good"  ${showAnswer ? "" : "disabled"} data-g="good">Good</button>
      <button class="btn easy"  ${showAnswer ? "" : "disabled"} data-g="easy">Easy</button>
    `;
    wireGradeButtons(buttons);
    return;
  }

  // Type mode (EN → RU only)
  const typed = (typingState?.text ?? "");
  const checked = Boolean(typingState?.checked);

  cardArea.innerHTML = `
    <div class="card">
      <div class="big">${escapeHtml(prompt)}</div>

      <label style="margin-top:12px;">Your answer (Russian)</label>
      <input
        id="typed"
        lang="ru"
        inputmode="text"
        autocomplete="off"
        autocapitalize="none"
        autocorrect="off"
        spellcheck="false"
        placeholder="Type Russian…"
        value="${escapeHtml(typed)}"
      />

      <div class="row" style="margin-top:10px;">
        <button class="btn primary" id="check">Check</button>
        <div class="spacer"></div>
        <button class="btn" id="clearTyped">Clear</button>
      </div>

      <div id="feedback" style="margin-top:12px;"></div>

      <div class="tiny muted" style="margin-top:12px;">
        reps: ${current.reps ?? 0} • interval: ${(current.intervalDays ?? 0).toFixed(1)}d • ease: ${(current.ease ?? 2.5).toFixed(2)}
      </div>
    </div>
  `;

  const typedInput = document.getElementById("typed");
  typedInput.addEventListener("input", () => {
    typingState.text = typedInput.value;
    typingState.checked = false;
    buttons.innerHTML = ``;
  });

  document.getElementById("clearTyped").onclick = () => {
    typingState.text = "";
    typingState.checked = false;
    render();
  };

  document.getElementById("check").onclick = () => {
    typingState.text = typedInput.value;
    typingState.checked = true;
    render();
  };

  const fb = document.getElementById("feedback");

  if (!checked) {
    fb.innerHTML = `<div class="muted">Tap <b>Check</b> when you’re ready. (Use 🌐 to switch to Russian keyboard.)</div>`;
  } else {
    const user = (typingState.text ?? "");
    const score = similarityScore(user, answer);

    const close = score >= 0.86;

    fb.innerHTML = `
      <div class="item" style="margin-top:0;">
        <div class="tiny muted">Your answer</div>
        <div style="margin-top:6px;">${escapeHtml(user || "—")}</div>

        <div style="margin-top:12px;" class="tiny muted">Correct answer</div>
        <div style="margin-top:6px;">${escapeHtml(answer)}</div>

        ${current.example ? `<div style="margin-top:12px;" class="tiny muted">Example</div><div style="margin-top:6px;" class="muted">${escapeHtml(current.example)}</div>` : ``}

        <div style="margin-top:12px;" class="tiny ${close ? "ok" : "danger"}">
          Similarity: ${(score*100).toFixed(0)}% • ${close ? "Looks close—grade yourself." : "Probably not—grade accordingly."}
        </div>
      </div>
    `;

    buttons.innerHTML = `
      <button class="btn again" data-g="again">Again</button>
      <button class="btn hard"  data-g="hard">Hard</button>
      <button class="btn good"  data-g="good">Good</button>
      <button class="btn easy"  data-g="easy">Easy</button>
    `;
    wireGradeButtons(buttons);
  }
}

function pickCurrent(due) {
  if (!due.length) return null;
  if (currentId && due.some(c => c.id === currentId)) return due.find(c => c.id === currentId);
  return due[0];
}

function wireGradeButtons(containerEl) {
  containerEl.querySelectorAll("button[data-g]").forEach(btn => {
    btn.onclick = () => {
      const g = btn.getAttribute("data-g");
      const cs = loadCards();
      const idx = cs.findIndex(c => c.id === currentId);
      if (idx >= 0) {
        const card = cs[idx];
        applyGrade(card, g);
        cs[idx] = card;
        saveCards(cs);
      }
      currentId = null;
      resetRevealAndTyping();
      render();
    };
  });
}

function renderAdd() {
  view.innerHTML = `
    <div class="card">
      <div class="big">Add card</div>

      <label>English</label>
      <input id="en" placeholder="e.g., to achieve" />

      <label>Russian</label>
      <input id="ru" lang="ru" inputmode="text" autocapitalize="none" autocorrect="off" spellcheck="false"
             placeholder="e.g., достичь / достигать" />

      <label>Example sentence</label>
      <textarea id="ex" lang="ru" inputmode="text" autocapitalize="none" autocorrect="off" spellcheck="false"
                placeholder="e.g., Он достиг своей цели."></textarea>

      <div class="row" style="margin-top:12px;">
        <button class="btn primary" id="save">Save</button>
        <div class="spacer"></div>
        <button class="btn" id="clear">Clear</button>
      </div>

      <div id="msg" class="tiny muted" style="margin-top:10px;"></div>
    </div>
  `;

  document.getElementById("save").onclick = () => {
    const en = document.getElementById("en").value;
    const ru = document.getElementById("ru").value;
    const ex = document.getElementById("ex").value;

    if (!en.trim() || !ru.trim()) {
      document.getElementById("msg").innerHTML = `<span class="danger">Need at least English + Russian.</span>`;
      return;
    }
    const cards = loadCards();
    cards.push(makeCard(en, ru, ex));
    saveCards(cards);
    document.getElementById("msg").innerHTML = `<span class="ok">Saved.</span>`;
    document.getElementById("en").value = "";
    document.getElementById("ru").value = "";
    document.getElementById("ex").value = "";
    updateHeader();
  };

  document.getElementById("clear").onclick = () => {
    document.getElementById("en").value = "";
    document.getElementById("ru").value = "";
    document.getElementById("ex").value = "";
    document.getElementById("msg").textContent = "";
  };
}

function renderCards(cards) {
  const list = cards
    .slice()
    .sort((a,b)=> (a.english||"").localeCompare(b.english||""))
    .map(c => `
      <div class="item">
        <div class="en">${escapeHtml(c.english)}</div>
        <div class="ru">${escapeHtml(c.russian)}</div>
        ${c.example ? `<div class="ex">${escapeHtml(c.example)}</div>` : ``}
        <div class="tiny muted" style="margin-top:8px;">
          due: ${new Date(c.dueAt || 0).toLocaleString()} • reps: ${c.reps ?? 0}
        </div>
        <div class="row" style="margin-top:10px;">
          <button class="btn" data-del="${c.id}">Delete</button>
          <div class="spacer"></div>
          <button class="btn" data-due="${c.id}">Make due now</button>
        </div>
      </div>
    `).join("");

  view.innerHTML = `
    <div class="card">
      <div class="big">Cards</div>
      <div class="tiny muted" style="margin-top:8px;">All data stays on this device (browser storage).</div>
      <div class="list" style="margin-top:14px;">${list || `<div class="muted">No cards yet.</div>`}</div>
    </div>
  `;

  view.querySelectorAll("button[data-del]").forEach(b => {
    b.onclick = () => {
      const id = b.getAttribute("data-del");
      const cs = loadCards().filter(c => c.id !== id);
      saveCards(cs);
      render();
    };
  });

  view.querySelectorAll("button[data-due]").forEach(b => {
    b.onclick = () => {
      const id = b.getAttribute("data-due");
      const cs = loadCards();
      const i = cs.findIndex(c => c.id === id);
      if (i >= 0) { cs[i].dueAt = nowMs(); saveCards(cs); }
      render();
    };
  });
}

function renderImportExport(cards) {
  view.innerHTML = `
    <div class="card">
      <div class="big">Import / Export</div>

      <div style="margin-top:12px;" class="muted">
        CSV format: <code>english,russian,example</code><br/>
        First row can be a header.
      </div>

      <label style="margin-top:14px;">Import CSV</label>
      <input id="csv" type="file" accept=".csv,text/csv" />
      <div class="row" style="margin-top:10px;">
        <button class="btn primary" id="doImport">Import</button>
        <button class="btn" id="clearAll">Delete ALL data</button>
      </div>
      <div id="importMsg" class="tiny muted" style="margin-top:10px;"></div>

      <hr style="border:0;border-top:1px solid #222;margin:18px 0;">

      <div class="row">
        <button class="btn" id="exportJSON">Export JSON backup</button>
        <button class="btn" id="exportCSV">Export CSV</button>
      </div>
      <div class="tiny muted" style="margin-top:10px;">
        Tip: keep a JSON backup occasionally. iOS can clear website storage in rare cases.
      </div>
    </div>
  `;

  const fileInput = document.getElementById("csv");
  const msg = document.getElementById("importMsg");

  document.getElementById("doImport").onclick = async () => {
    const f = fileInput.files && fileInput.files[0];
    if (!f) { msg.innerHTML = `<span class="danger">Pick a CSV file first.</span>`; return; }
    const text = await f.text();
    const rows = parseCSV(text);
    if (!rows.length) { msg.innerHTML = `<span class="danger">CSV looks empty.</span>`; return; }

    const first = rows[0].map(x => String(x).trim().toLowerCase());
    let start = 0;
    if (first.includes("english") && first.includes("russian")) start = 1;

    let added = 0;
    const cs = loadCards();
    for (let i = start; i < rows.length; i++) {
      const [en, ru, ex] = rows[i];
      if (!String(en||"").trim() || !String(ru||"").trim()) continue;
      cs.push(makeCard(en, ru, ex || ""));
      added++;
    }
    saveCards(cs);
    msg.innerHTML = `<span class="ok">Imported ${added} card(s).</span>`;
    render();
  };

  document.getElementById("clearAll").onclick = () => {
    const ok = confirm("Delete ALL cards on this device?");
    if (!ok) return;
    localStorage.removeItem(STORAGE_KEY);
    msg.innerHTML = `<span class="ok">Cleared.</span>`;
    render();
  };

  document.getElementById("exportJSON").onclick = () => {
    const json = JSON.stringify(loadCards(), null, 2);
    downloadFile(`vocabsrs-backup-${new Date().toISOString().slice(0,10)}.json`, json, "application/json");
  };

  document.getElementById("exportCSV").onclick = () => {
    downloadFile(`vocabsrs-${new Date().toISOString().slice(0,10)}.csv`, toCSV(loadCards()), "text/csv");
  };
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

/* Similarity scoring for Type mode */
function normalizeAnswer(s) {
  return String(s ?? "")
    .toLowerCase()
    .trim()
    .replaceAll("ё", "е")
    .replace(/[\u2019’']/g, "'")
    .replace(/[^a-zа-я0-9\s\-]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a, b) {
  a = normalizeAnswer(a);
  b = normalizeAnswer(b);
  if (!a && !b) return 0;
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

function similarityScore(user, correct) {
  const a = normalizeAnswer(user);
  const b = normalizeAnswer(correct);
  if (!a && !b) return 1;
  if (!a || !b) return 0;

  const variants = b.split("/").map(x => x.trim()).filter(Boolean);
  const candidates = variants.length ? variants : [b];

  let best = 0;
  for (const cand of candidates) {
    const dist = levenshtein(a, cand);
    const maxLen = Math.max(a.length, cand.length);
    const score = maxLen ? (1 - dist / maxLen) : 0;
    best = Math.max(best, score);
  }
  return best;
}

/* Tabs */
function setActiveTabUI() {
  document.querySelectorAll(".tab").forEach(t => {
    t.classList.toggle("active", t.dataset.tab === activeTab);
  });
}

document.querySelectorAll(".tab").forEach(t => {
  t.addEventListener("click", () => {
    activeTab = t.dataset.tab;
    resetRevealAndTyping();
    setActiveTabUI();
    render();
  });
});

/* Service worker (offline) */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(()=>{});
  });
}

window.addEventListener("online", updateHeader);
window.addEventListener("offline", updateHeader);

/* Boot */
seedIfEmpty();
setActiveTabUI();
render();
