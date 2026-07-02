const https = require("https");
const crypto = require("crypto");

const TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const SHEET_ID = process.env.SHEET_ID;
const GOOGLE_SERVICE_EMAIL = process.env.GOOGLE_SERVICE_EMAIL;
const GOOGLE_PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
const BOSS_CHAT_ID = "8291918824";

console.log("Bot RH démarré, token:", TOKEN ? TOKEN.substring(0, 15) + "..." : "MANQUANT");
console.log("Sheets service:", GOOGLE_SERVICE_EMAIL ? "OK" : "MANQUANT");

// ─── TELEGRAM ────────────────────────────────────────────────────────────────
function telegramRequest(method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      { hostname: "api.telegram.org", path: `/bot${TOKEN}/${method}`, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } },
      (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(JSON.parse(d))); }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function sendMessage(chatId, text) {
  return telegramRequest("sendMessage", { chat_id: chatId, text, parse_mode: "Markdown" });
}

// ─── SHEETS (compte de service JWT) ───────────────────────────────────────────
async function getSheetsAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: GOOGLE_SERVICE_EMAIL,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600, iat: now
  };
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claim)).toString("base64url");
  const signingInput = `${header}.${payload}`;
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(signingInput);
  const signature = sign.sign(GOOGLE_PRIVATE_KEY, "base64url");
  const jwt = `${signingInput}.${signature}`;

  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt
    }).toString();
    const req = https.request(
      { hostname: "oauth2.googleapis.com", path: "/token", method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) } },
      (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => { try { resolve(JSON.parse(d).access_token || null); } catch(e) { resolve(null); } }); }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function sheetsRequest(path, accessToken, method = "GET", body = null) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" };
    if (data) headers["Content-Length"] = Buffer.byteLength(data);
    const req = https.request(
      { hostname: "sheets.googleapis.com", path, method, headers },
      (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } }); }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function addHoursToSheet(date, employee, hours, comment) {
  const token = await getSheetsAccessToken();
  if (!token) return "⚠️ Erreur de connexion. Préviens ton responsable.";
  const body = { values: [[date, employee, hours, comment || ""]] };
  const result = await sheetsRequest(
`/v4/spreadsheets/${SHEET_ID}/values/A:D:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    token, "POST", body
  );
  return result.updates ? `✅ Merci ! J'ai bien enregistré *${hours}h* pour *${employee}* le ${date}.` : "⚠️ Erreur d'enregistrement. Réessaie.";
}

// ─── CLAUDE ──────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Tu es l'assistant RH d'un restaurant. Ton unique rôle est d'enregistrer les heures de travail des employés qui t'écrivent.

Les employés t'envoient leurs heures en langage naturel. Ils travaillent souvent en COUPURE (service du midi + service du soir), donc ils peuvent te donner plusieurs créneaux.

EXEMPLES :
- "j'ai fait 8h aujourd'hui" → 8 heures
- "de 9h à 17h" → 8 heures
- "10h00 / 14h00 puis 17h00 / 23h30" → 4h + 6h30 = 10h30
- "midi 11h-15h et soir 18h-minuit" → 4h + 6h = 10h

RÈGLE DE CALCUL : quand l'employé donne plusieurs créneaux, calcule chaque créneau puis ADDITIONNE. Convertis les minutes en décimales (23h30 - 17h00 = 6.5).

PROCESSUS EN DEUX ÉTAPES :

ÉTAPE 1 — CONFIRMATION : quand tu as le prénom + le total d'heures, tu NE réponds PAS encore avec le JSON. À la place, tu récapitules et demandes confirmation en français, par exemple :
"📋 Je note *10h30* pour *Marc* le *01/07/2026* (10h-14h + 17h-23h30). C'est bon ? Réponds *oui* pour valider ✅"

ÉTAPE 2 — VALIDATION : si l'employé confirme (oui, ok, c'est bon, valide, parfait...), tu réponds ALORS UNIQUEMENT avec ce JSON, sans aucune explication :
{"action":"log_hours","date":"JJ/MM/AAAA","employee":"prénom","hours":"X","comment":"détail des créneaux"}

Si l'employé corrige quelque chose, refais une confirmation avec les bonnes infos.

- Si tu ne connais pas le prénom, demande-le d'abord.
- Mémorise le prénom pour la conversation.
- Utilise la date de travail fournie ci-dessous.

Sois chaleureux, simple et bref. Réponds toujours en français.
NE JAMAIS expliquer le fonctionnement technique.`;
function getBusinessDate() {
  // Heure actuelle en fuseau de Paris
  const parisNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Paris" }));
  // Si avant 3h du matin, on rattache à la veille
  if (parisNow.getHours() < 3) {
    parisNow.setDate(parisNow.getDate() - 1);
  }
  const jj = String(parisNow.getDate()).padStart(2, "0");
  const mm = String(parisNow.getMonth() + 1).padStart(2, "0");
  const aaaa = parisNow.getFullYear();
  return `${jj}/${mm}/${aaaa}`;
}

async function askClaude(history, message) {
  const businessDate = getBusinessDate();
  const messages = [...history, { role: "user", content: message }];
  const body = JSON.stringify({
    model: "claude-sonnet-4-6", max_tokens: 400,
    system: SYSTEM_PROMPT + `\n\nDate de travail à utiliser pour l'enregistrement : ${businessDate}`, messages
  });
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY,
                   "anthropic-version": "2023-06-01", "Content-Length": Buffer.byteLength(body) } },
      (res) => {
        let d = "";
        res.on("data", c => d += c);
        res.on("end", () => { try { resolve(JSON.parse(d).content?.[0]?.text || "Désolé, réessaie."); } catch(e) { reject(e); } });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── HANDLER ─────────────────────────────────────────────────────────────────
const userState = {};

async function handleUpdate(update) {
  if (!update.message?.text) return;
  const chatId = update.message.chat.id;
  const text = update.message.text;

  if (!userState[chatId]) userState[chatId] = { history: [] };
  const state = userState[chatId];

  if (text === "/start") {
    await sendMessage(chatId, "👋 *Bonjour !*\n\nJe suis l'assistant qui enregistre tes heures de travail.\n\nDis-moi simplement ton prénom et tes heures, par exemple :\n_\"Je suis Julie, j'ai fait 8h aujourd'hui\"_");
    return;
  }
  if (text === "/reset") {
    state.history = [];
    await sendMessage(chatId, "🔄 On recommence à zéro. Quel est ton prénom ?");
    return;
  }

  await telegramRequest("sendChatAction", { chat_id: chatId, action: "typing" });

  try {
    const reply = await askClaude(state.history, text);

    try {
      const parsed = JSON.parse(reply);
      if (parsed.action === "log_hours") {
        const result = await addHoursToSheet(parsed.date, parsed.employee, parsed.hours, parsed.comment);
        // On garde le prénom en mémoire
        state.history.push({ role: "user", content: text });
        state.history.push({ role: "assistant", content: `Heures enregistrées pour ${parsed.employee}.` });
        await sendMessage(chatId, result);
        return;
      }
    } catch(e) { /* Pas un JSON */ }

    state.history.push({ role: "user", content: text });
    state.history.push({ role: "assistant", content: reply });
    if (state.history.length > 20) state.history = state.history.slice(-20);
    await sendMessage(chatId, reply);

  } catch(err) {
    console.error("Erreur:", err);
    await sendMessage(chatId, "⚠️ Petit souci technique, réessaie dans un instant.");
  }
}

// ─── POLLING ─────────────────────────────────────────────────────────────────
let offset = 0;
async function poll() {
  try {
    const result = await telegramRequest("getUpdates", { offset, timeout: 25, allowed_updates: ["message"] });
    if (result.ok && result.result.length > 0) {
      for (const update of result.result) {
        offset = update.update_id + 1;
        await handleUpdate(update);
      }
    }
  } catch(err) { console.error("Erreur polling:", err.message); }
  setTimeout(poll, 500);
}
// ─── RÉCAP QUOTIDIEN À 3H00 (heure de Paris) ──────────────────────────────────
async function getDailyReport(dateStr) {
  const token = await getSheetsAccessToken();
  if (!token) return null;
  const result = await sheetsRequest(`/v4/spreadsheets/${SHEET_ID}/values/A:D`, token);
  if (!result.values || result.values.length <= 1) return null;

  const totals = {};
  for (const row of result.values) {
    if (row[0] === "Date" || !row[0] || !row[1] || !row[2]) continue;
    if (row[0].trim() === dateStr) {
      const employee = row[1].trim();
      totals[employee] = (totals[employee] || 0) + (parseFloat(row[2]) || 0);
    }
  }
  if (Object.keys(totals).length === 0) return `🌙 *Récap du ${dateStr}*\n\nAucune heure enregistrée aujourd'hui.`;

  let out = `🌙 *Récap du ${dateStr}*\n\n`;
  let total = 0;
  for (const [employee, hours] of Object.entries(totals).sort()) {
    out += `👤 ${employee} — *${hours}h*\n`;
    total += hours;
  }
  out += `\n⏱️ *Total équipe : ${total}h*`;
  return out;
}

let lastReportDate = null;
async function checkDailyReport() {
  const parisNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Paris" }));
  const h = parisNow.getHours();
  const m = parisNow.getMinutes();

  // La journée qui vient de se terminer = la veille de "maintenant" à 3h
  const businessDay = new Date(parisNow);
  businessDay.setDate(businessDay.getDate() - 1);
  const jj = String(businessDay.getDate()).padStart(2, "0");
  const mm = String(businessDay.getMonth() + 1).padStart(2, "0");
  const dateStr = `${jj}/${mm}/${businessDay.getFullYear()}`;

  // Déclenche une seule fois entre 3h00 et 3h04
  if (h === 3 && m < 5 && lastReportDate !== dateStr) {
    lastReportDate = dateStr;
    const report = await getDailyReport(dateStr);
    if (report) await sendMessage(BOSS_CHAT_ID, report);
    console.log("Récap quotidien envoyé pour", dateStr);
  }
}
setInterval(checkDailyReport, 60 * 1000); // vérifie chaque minute
poll();
