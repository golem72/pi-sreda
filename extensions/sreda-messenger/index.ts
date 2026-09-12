/**
 * Sreda messenger extension — уведомления «Агент pi.dev.» через skill `sreda_send`.
 *
 * Расширение НЕ обращается к API «Среды» напрямую (OAuth/TLS/отправка — всё делает
 * Python-скрилл skills/sreda_send/sreda_send.py). TS только:
 *
 *   1. при ОКОНЧАТЕЛЬНОМ завершении работы агента: агент_settled + «тихое окно»
 *      (ctx.isIdle() — true, нет очереди сообщений, и в течение QUIET_MS не стартовало
 *      новое выполнение — queued continuation / steering / авто-ретрай).
 *      В этом случае:
 *        сообщение 1 (текст, переносы как задано):
 *          Pi-агент. Сессия:
 *          <имя сессии>
 *          Работа завершена
 *          дд.мм.гггг чч:мм:сс
 *        сообщение 2: вложение «otvet.pdf» — финальный ответ агента,
 *                     отрендеренный в PDF через `node <skill>/md2pdf.cjs`;
 *                     если node/chromium недоступны — только текст, ошибка в TUI.
 *      Если в течение тихого окна агент продолжил работать — «Завершена» НЕ шлётся.
 *
 *   2. при возобновлении работы агента (новое сообщение пользователя в сессии, где уже
 *      есть ответ ассистента, и не сразу после «тихого окна» незавершённого хода):
 *        Pi-агент. Сессия:
 *        <имя сессии>
 *        возобновлена
 *        дд.мм.гггг чч:мм:сс
 *
 * Имя сессии: ctx.sessionManager.getSessionName(); если не задано — «(без названия)».
 *
 * Защита от ложных срабатываний:
 *   — если последнее сообщение сессии — assistant-вызов субагента
 *     (subagent / subagent_resume, после него нет tool_result), агент ждёт результат субагента —
 *     это НЕ окончание работы: «Работа завершена» не отправляется;
 *   — MUTE: если в .sreda-notify.json записан "enabled" false (или LLM вызвал
 *     tool sreda_notify enabled=false, когда пользователь попросил не присылать сообщений) —
 *     ни одно автоматическое сообщение не отправляется, в TUI показывается «MUTE»;
 *
 * Настройки:
 *   config.json рядом с index.ts:      { "recipient": "32.klorshteinve@rosstat.gov.ru" }
 *   логин/пароль/токены — skills/sreda_send/config.json (state в .sreda/).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFile, spawnSync } from "node:child_process";

// ─────────────────────────────────────────────── конфиг и поиск интерпретаторов

interface SredaConfig { recipient: string }

interface ScriptInfo {
  python: string;
  script: string;
  node: string | null;
  md2pdf: string | null;
  cfg: SredaConfig;
}

function loadConfig(ext_dir: string): SredaConfig | null {
  const cfgPath = path.join(ext_dir, "config.json");
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as SredaConfig;
    if (!cfg.recipient || !cfg.recipient.trim()) return null;
    if (!cfg.recipient.includes("@")) cfg.recipient += "@rosstat.gov.ru";
    return cfg;
  } catch {
    console.error(`[Sreda-Ext] нет config.json с 'recipient' в ${cfgPath}`);
    return null;
  }
}

function findBin(cmds: string[], probe: string[]): string | null {
  for (const cmd of cmds) {
    const r = spawnSync(cmd, probe, { timeout: 5000, stdio: "ignore" });
    if (r.status === 0) return cmd;
  }
  return null;
}

function findNode(): string | null {
  let n = findBin(["node"], ["--version"]);
  if (n) return n;
  // резерв: пи-нод в домашнем каталоге
  try {
    const base = path.join(os.homedir(), ".local/share/pi-node");
    for (const d of fs.readdirSync(base).sort().reverse()) {
      const c = path.join(base, d, "bin/node");
      if (fs.existsSync(c)) return c;
    }
  } catch { /* нет каталога */ }
  return null;
}

function findPython(): string | null {
  return findBin(["python3", "python"], ["-V"]);
}

function findScript(ext_dir: string): string | null {
  const home = os.homedir();
  const cands = [
    path.join(home, ".pi/agent/skills/sreda_send/sreda_send.py"),
    path.join(home, ".pi/skills/sreda_send/sreda_send.py"),
    path.join(ext_dir, "..", "..", "skills", "sreda_send", "sreda_send.py"),
  ];
  for (const p of cands) if (fs.existsSync(p)) return path.resolve(p);
  console.error("[Sreda-Ext] skills/sreda_send/sreda_send.py не найден:\n  " + cands.join("\n  "));
  return null;
}

function resolveScript(ext_dir: string): ScriptInfo | null {
  const cfg = loadConfig(ext_dir);
  const script = findScript(ext_dir);
  const python = findPython();
  if (!cfg || !script || !python) return null;
  const md2pdf = path.join(path.dirname(script), "md2pdf.cjs");
  return {
    python,
    script,
    node: findNode(),
    md2pdf: fs.existsSync(md2pdf) ? md2pdf : null,
    cfg,
  };
}

// ─────────────────────────────────────────────── вызов скрилла

interface ProcResult { code: number; out: string; err: string }

function runScript(info: ScriptInfo, args: string[], timeoutMs = 300_000): Promise<ProcResult> {
  return new Promise((resolve) => {
    execFile(info.python, [info.script, ...args], {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const code: number = error ? (typeof (error as { code?: unknown }).code === "number"
        ? (error as { code: number }).code : 1) : 0;
      resolve({ code, out: String(stdout ?? ""), err: String(stderr ?? "") });
    });
  });
}

/** Имя сессии для уведомлений; если не задано — «(без названия)». */
function sessionName(ctx: any): string {
  try {
    const n = (ctx && ctx.sessionManager && typeof ctx.sessionManager.getSessionName === "function")
      ? ctx.sessionManager.getSessionName() : undefined;
    if (n && String(n).trim()) return String(n).trim();
  } catch { /* ignore */ }
  return "(без названия)";
}

/** Метка времени отправки: дд.мм.гггг чч:мм:сс (локальная зона). */
function fmtTs(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Последний текстовый ответ агента (последнее assistant-сообщение с текстом). */
function lastAssistantText(ctx: any): string {
  try {
    const sm = ctx?.sessionManager;
    const entries: any[] =
      (typeof sm?.buildContextEntries === "function" ? sm.buildContextEntries() : null) ??
      (typeof sm?.getBranch === "function" ? sm.getBranch() : null) ??
      [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (!e || e.type !== "message" || e.message?.role !== "assistant") continue;
      const c = e.message.content;
      let texts: string[];
      if (Array.isArray(c)) {
        texts = c
          .filter((b: any) => b?.type === "text" && typeof b.text === "string")
          .map((b: any) => b.text);
      } else if (typeof c === "string") {
        texts = [c];
      } else {
        texts = [];
      }
      const t = texts.join("\n").trim();
      if (t) return t;
    }
  } catch { /* ignore */ }
  return "";
}

function notify(pi: ExtensionAPI, text: string, kind: "info" | "error"): void {
  try { (pi as any).ui?.notify?.(text, kind); } catch { /* ignore */ }
}

// ─────────────────────────────────────────────── MUTE-состояние

const STATE_PATH = path.join(__dirname, ".sreda-notify.json");

function stateEnabled(): boolean {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    return s.enabled !== false;
  } catch { /* нет файла — уведомления включены */ return true; }
}

function setStateEnabled(v: boolean): void {
  try { fs.writeFileSync(STATE_PATH, JSON.stringify({ enabled: v, ts: Date.now() }, null, 2) + "\n", "utf8"); } catch { /* ignore */ }
}

/** Последняя (хвостовая) запись ветки — assistant-вызов субагента, после которого
 *  ещё не было tool_result → агент ждёт результат субагента (fire-and-forget). */
function hasPendingSubagent(ctx: any): boolean {
  try {
    const sm = ctx?.sessionManager;
    const entries: any[] =
      (typeof sm?.buildContextEntries === "function" ? sm.buildContextEntries() : null) ??
      (typeof sm?.getBranch === "function" ? sm.getBranch() : null) ??
      [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (!e) continue;
      if (e.type !== "message") continue; // custom entries между — не мешают
      if (e.message?.role === "user") return false; // после вызова вернулся result/новое сообщение — уже не ожидание
      if (e.message?.role !== "assistant") continue;
      const c = e.message.content;
      const arr = Array.isArray(c) ? c : [c];
      // Считаем ТОЛЬКО реальный незавершённый вызов инструмента subagent/subagent_resume.
      // Упоминание слова «subagent» в ТЕКСТЕ сообщения — НЕ ожидание (ложное срабатывание).
      const toolCalls = arr.filter(
        (b: any) =>
          b && typeof b === "object" &&
          (b.type === "toolCall" || b.type === "tool_use" || b.type === "toolUse") &&
          typeof b.name === "string",
      );
      const hit = toolCalls.some((b: any) => /subagent(_resume)?$/i.test(b.name));
      if (hit) return true;
      return false; // ассистент-сообщение без вызова субагента — ожидание отсутствует
    }
  } catch { /* по умолчанию: без ожидания */ }
  return false;
}

// ─────────────────────────────────────────────── действия

const EXT_DIR = __dirname;
const info = resolveScript(EXT_DIR);
if (!info) {
  console.error("[Sreda-Ext] инициализация не удалась — уведомления выключены");
}

const cfg = info ? info.cfg : null;

/** Тихое окно после agent_settled: за него не стартовало новое выполнение — агент «остыл» по-настоящему. */
const QUIET_MS = 3000;
let _pendingDone: ReturnType<typeof setTimeout> | null = null;
let _chain: Promise<void> = Promise.resolve();

/** Очередь отправок: без параллельных дублей, без взаимных блокировок. */
function enqueueWork(fn: () => Promise<void>): Promise<void> {
  const p = _chain.then(fn).catch((e: unknown) => {
    console.error("[Sreda-Ext] " + (e as Error).message);
  });
  _chain = p;
  return p;
}

/** Сообщение 1: только текст. */
async function sendText(text: string): Promise<boolean> {
  if (!info || !cfg) return false;
  const r = await runScript(info, ["send", "--to", cfg.recipient, "--text", text]);
  if (r.code !== 0) console.error("[Sreda-Ext] send text: code=" + r.code + " err=" + r.err.trim().slice(-800));
  return r.code === 0;
}

/** Сообщение 2: вложение otvet.pdf (финальный ответ агента), без отдельного текста. */
async function sendOtvotPdf(replyText: string): Promise<boolean> {
  if (!info || !cfg) return false;
  if (!info.node || !info.md2pdf) {
    console.error("[Sreda-Ext] node/md2pdf.cjs недоступны — otvet.pdf не сформирован");
    return false;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sreda-otvet-"));
  const src = path.join(dir, "otvet.src.md");
  const pdf = path.join(dir, "otvet.pdf"); // базовое имя — otvet.pdf (именно так придёт в чате)
  let okConv = false;
  try {
    fs.writeFileSync(src, replyText, "utf8");
    const r = spawnSync(info.node, [info.md2pdf, src, pdf], {
      timeout: 180_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    okConv = r.status === 0 && fs.existsSync(pdf) && fs.statSync(pdf).size > 0;
    if (!okConv) console.error("[Sreda-Ext] md2pdf: exit=" + r.status + " err=" + String(r.stderr ?? "").trim().slice(-800));
  } catch (e) {
    console.error("[Sreda-Ext] md2pdf: " + (e as Error).message);
  }
  if (!okConv) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    return false;
  }
  const r = await runScript(info, ["send", "--to", cfg.recipient, "--attach", pdf]);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  if (r.code !== 0) console.error("[Sreda-Ext] send otvet.pdf: code=" + r.code + " err=" + r.err.trim().slice(-800));
  return r.code === 0;
}

/** Завершение работы: текст, затем otvet.pdf. */
async function notifyDone(pi: ExtensionAPI, replyText: string, name: string): Promise<void> {
  if (!stateEnabled()) {
    notify(pi, "Sreda: MUTE - «Работа завершена» не отправлена", "info");
    console.error("[Sreda-Ext] MUTE - завершение не отправлено");
    return;
  }
  const text = `Pi-агент. Сессия:\n${name}\nРабота завершена\n${fmtTs()}`;
  const okText = await sendText(text);
  let pdf: string = "";
  if (replyText.trim()) {
    if (await sendOtvotPdf(replyText)) pdf = " + otvet.pdf";
    else pidErr();
  } else {
    console.error("[Sreda-Ext] рабочий ответ агента пуст — otvet.pdf не отправлен");
  }
  notify(pi, "Среда: " + text.replace(/\n/g, " ") + pdf, "info");
  function pidErr(): void {
    console.error("[Sreda-Ext] otvet.pdf не отправлен (node/Chromium недоступны?)");
  }
}

/** Возобновление работы: только текст. */
async function notifyResumed(pi: ExtensionAPI, name: string): Promise<void> {
  if (!stateEnabled()) {
    notify(pi, "Sreda: MUTE - «возобновлена» не отправлена", "info");
    console.error("[Sreda-Ext] MUTE - возобновление не отправлено");
    return;
  }
  const text = `Pi-агент. Сессия:\n${name}\nвозобновлена\n${fmtTs()}`;
  const ok = await sendText(text);
  notify(pi, "Среда: " + text.replace(/\n/g, " "), ok ? "info" : "error");
}

// ─────────────────────────────────────────────── события

/** Забегалка: pi-процесс запущен как субагент (PI_SUBAGENT_* заданы) —
 *  у субагента уведомления «Среды» отключены полностью: только основной агент уведомляет. */
const IN_SUBAGENT = Boolean(
  process.env.PI_SUBAGENT_ID ?? process.env.PI_SUBAGENT_NAME ?? process.env.PI_SUBAGENT_SESSION,
);
if (IN_SUBAGENT) {
  console.error("[Sreda-Ext] работает как субагент (PI_SUBAGENT_*) - уведомления в «Среду» отключены");
}

export default function (pi: ExtensionAPI): void {
  // ── tool переключения уведомлений (вызывает LLM, когда пользователь просит не слать / слать) ──
  try {
    pi.registerTool({
      name: "sreda_notify",
      label: "Sreda Notify",
      description:
        "Включить/выключить автоуведомления в мессенджер «Среда» от расширения sreda-messenger. " +
        "Use when the user asks the agent NOT to send messenger messages/notifications (enabled=false) " +
        "or to resume them (enabled=true).",
      promptSnippet: "Turn Sreda messenger auto-notifications on or off",
      parameters: Type.Object({ enabled: Type.Boolean() }),
      async execute(_toolCallId: string, params: { enabled: boolean }) {
        const v = params.enabled === true;
        setStateEnabled(v);
        const msg = v ? "Sreda: автоматические уведомления ВКЛЮЧЕНЫ" : "Sreda: автоматические уведомления ВЫКЛЮЧЕНЫ";
        console.error("[Sreda-Ext] " + msg);
        return { content: [{ type: "text", text: msg }] };
      },
    });
  } catch (e) {
    console.error("[Sreda-Ext] registerTool(sreda_notify): " + (e as Error).message);
  }

  if (!info) {
    pi.on("agent_settled", () => {
      console.error("[Sreda-Ext] нет скрила/конфига — уведомление о завершении не отправлено");
    });
    return;
  }

  // ── ОКОНЧАТЕЛЬНОЕ завершение: агент_settled + тихое окно ──
  // isIdle() = false, пока pi обработывает ран, авто-ретрай, auto-compact или очередь;
  // hasPendingMessages() — есть queued продолжения. В этих случаях «Завершена» не шлём.
  pi.on("agent_settled", async (_event: any, ctx: any) => {
    if (IN_SUBAGENT) return;
    let idle = true;
    let pending = false;
    try {
      if (typeof ctx?.isIdle === "function") idle = ctx.isIdle();
      if (typeof ctx?.hasPendingMessages === "function") pending = ctx.hasPendingMessages();
    } catch { /* по умолчанию считаем idle */ }
    if (!idle || pending) return; // pi может продолжить автоматически — это не окончание
    if (_pendingDone) clearTimeout(_pendingDone);
    _pendingDone = setTimeout(() => {
      _pendingDone = null;
      if (hasPendingSubagent(ctx)) {
        console.error("[Sreda-Ext] агент ждёт результат субагента - «Работа завершена» не отправлена");
        return;
      }
      void enqueueWork(async () => {
        await notifyDone(pi, lastAssistantText(ctx), sessionName(ctx));
      });
    }, QUIET_MS);
  });

  // новое выполнение стартовало в течение тихого окна (очередь, steering, ретрай) —
  // агент продолжает работу; «Завершена» отменяем
  pi.on("agent_start", () => {
    if (_pendingDone) { clearTimeout(_pendingDone); _pendingDone = null; }
  });

  // ── возобновление: новое сообщение пользователя, когда агент по-настоящему завершил работу ──
  // сообщения «сразу после хода» (внутри тихого окна) — это продолжение той же работы:
  // ни «Завершена», ни «Возобновлена» не шлём.
  pi.on("input", async (event: any, ctx: any) => {
    if (IN_SUBAGENT) return;
    const text = String(event?.text ?? "").trim();
    if (!text) return;
    if (event?.source === "extension") return; // не уведомлять на инъекциянные сообщения
    if (text.startsWith("/")) return;          // TUI-команда, не работа
    if (hasPendingSubagent(ctx)) return;      // результат субагента/продолжение — не возобновление
    if (!lastAssistantText(ctx)) return;       // первое сообщение сессии — это старт, не возобновление
    if (typeof ctx?.isIdle === "function" && ctx.isIdle() === false) return; // агент уже работает — это не возобновление
    if (_pendingDone) {                        // continuation сразу после хода — промолчать
      clearTimeout(_pendingDone); _pendingDone = null;
      return;
    }
    void enqueueWork(() => notifyResumed(pi, sessionName(ctx)));
  });
}
