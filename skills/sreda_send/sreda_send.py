#!/usr/bin/env python3
"""
sreda_send — отправка сообщений в мессенджер «Среда» (armgs) от имени пользователя.

Возможности:
  * холодный OAuth-вход (8 шагов) по user/password из config.json,
  * сохранение/чтение токена и aimsid (state, 24 h TTL) в каталоге tokenDir;
  * отправка текста одному или нескольким получателям;
  * отправка файлов (вложений) с подписью — загрузка идёт тем же способом,
    что и в веб-клиенте webim.armgs.team (files/init -> upload -> files/info -> sendIM).

CLI:
  python3 sreda_send.py token                          # принудительный cold OAuth + сохранение state
  python3 sreda_send.py send --to USER [--to U2 ...] \
      [--text "текст"] [--attach ФАЙЛ ...] [--no-pdf]

Вложения: текстовые файлы (md/txt) автоматически конвертируются в PDF
(node + Chromium, см. md2pdf.cjs), т.к. Среда-клиент плохо отображает
«неопознанные» типы. Отключить: --no-pdf (или SREDAS_NO_PDF=1).

config.json (рядом со скриптом):
  {
    "user":     "32.SAD",                              # без @rosstat.gov.ru
    "password": "…",
    "domain":   "rosstat.gov.ru",                      # опционально, по умолчанию rosstat.gov.ru
    "tokenDir": "..."                                  # опционально; пусто => <skill>/.sreda/
  }
"""
from __future__ import annotations

import argparse
import json
import math
import os
import random
import re
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.parse import quote, unquote

try:
    import requests
except ImportError:
    print("ОШИБКА: не установлен пакет requests (pip3 install requests)", file=sys.stderr)
    sys.exit(2)

SKILL_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CONFIG = os.path.join(SKILL_DIR, "config.json")
DOMAIN_DEFAULT = "rosstat.gov.ru"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
WEBIM_ORIGIN = "https://webim.armgs.team"
U_HOST = "https://u.armgs.team"
API = "/api/v135"
CHUNK_SIZE = 10 * 1024 * 1024  # 10 МБ на чанк
TOKEN_TTL_SEC = 24 * 3600

# Вложения, которые Среда-клиент показывает как сырую ссылку/скрывает:
# текстовые типы. Для них делаем автоконвертацию в PDF (md2pdf.cjs).
PDFIFY_EXTS = {".md", ".markdown", ".txt", ".text"}
MD2PDF = os.path.join(SKILL_DIR, "md2pdf.cjs")


# ─────────────────────────────────────────────── конфиг и state

def load_config(path: str = DEFAULT_CONFIG) -> dict:
    with open(path, encoding="utf-8") as f:
        cfg = json.load(f)
    for key in ("user", "password"):
        if not cfg.get(key):
            print(f"ОШИБКА: в {path} нет поля '{key}'", file=sys.stderr)
            sys.exit(2)
    cfg.setdefault("domain", DOMAIN_DEFAULT)
    return cfg


def get_state_path(cfg: dict) -> str:
    td = (cfg.get("tokenDir") or "").strip()
    if td and not os.path.isabs(td):
        td = os.path.join(SKILL_DIR, td)
    base = td or os.path.join(SKILL_DIR, ".sreda")
    return os.path.join(base, "state.json")


def save_state(cfg: dict, st: dict) -> str:
    p = get_state_path(cfg)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    st = dict(st)
    st["updated"] = int(time.time())
    with open(p, "w", encoding="utf-8") as f:
        json.dump(st, f, indent=2)
    try:
        os.chmod(p, 0o600)
    except OSError:
        pass
    return p


def load_state(cfg: dict) -> dict | None:
    p = get_state_path(cfg)
    try:
        with open(p, encoding="utf-8") as f:
            st = json.load(f)
    except Exception:
        return None
    ok = (st.get("token") and st.get("aimsid")
          and int(st.get("expiryMs") or 0) > time.time() * 1000 + 60_000)
    return st if ok else None


def now_ms() -> int:
    return int(time.time() * 1000)


def jitter() -> None:
    """Человеческая задержка между шагами OAuth (против SDC/антибота armgs)."""
    time.sleep(0.4 + random.random() * 0.3)


def request_id() -> str:
    return f"{random.randint(10000, 99999)}-{int(round(time.time()) - 0.5)}"


def norm_recipient(to: str, domain: str) -> str:
    return to if "@" in to else f"{to}@{domain}"


# ─────────────────────────────────────────────── клиент «Среды»

class SredaClient:
    def __init__(self, cfg: dict, state: dict | None = None, verbose: bool = True):
        self.cfg = cfg
        self.em = f"{cfg['user']}@{cfg['domain']}"
        self.verbose = verbose
        self.s = requests.Session()
        self.s.headers.update({"user-agent": UA, "accept": "*/*"})
        if state:
            self.token: str = state["token"]
            self.aimsid: str = state["aimsid"]
        else:
            self.token = ""
            self.aimsid = ""
        self.pw = cfg["password"]

    def log(self, msg: str) -> None:
        if self.verbose:
            print(f"[sreda_send] {msg}", file=sys.stderr)

    # ── cold OAuth (8 шагов) ──────────────────────────────
    def login(self) -> None:
        s = self.s
        # Step 1 - myteam-config
        self.log("step1 myteam-config")
        r = s.get(f"{U_HOST}/myteam-config.json",
                  params={"r": str(int(time.time() * 1000)),
                          "domain": self.cfg["domain"], "email": self.cfg["user"]},
                  timeout=20)
        if r.status_code != 200:
            raise RuntimeError(f"step1 myteam-config -> {r.status_code}")
        jitter()

        # Step 2 - authorize: достать client_id и state из редиректов
        self.log("step2 authorize")
        r = s.get(f"{U_HOST}/api/v125/idm/auth/authorize",
                  params={"client_id": "dGFybS13ZWIK", "response_type": "code",
                          "redirect_uri": f"{WEBIM_ORIGIN}/", "login_hint": self.em,
                          "state": "49810", "scope": "openid", "type": "SWA"},
                  timeout=20)
        cid = st = ""
        for resp in list(r.history) + [r]:
            url = resp.headers.get("location") or resp.url
            m = re.search(r"client_id=([^&]+)", url)
            if m and not cid:
                cid = unquote(m.group(1))
            m2 = re.search(r"state=([^&]+)", url)
            if m2 and not st:
                st = unquote(m2.group(1))
        if not cid or not st:
            raise RuntimeError("step2: не найдены client_id/state")
        self.log(f"  cid={cid[:10]}... state={st}")

        # Step 3 - страница login, cookie act (act_token)
        self.log("step3 login page")
        lu = (f"https://account.armgs.team/login?opener=o2&x=login"
              f"&page=https://o2.armgs.team/login?client_id={cid}&login={quote(self.em)}"
              f"&redirect_uri=https%3A%2F%2Fu.armgs.team%2Fapi%2Fv1%2Fidm%2Fauth%2Fcallback"
              f"&response_type=code&scope=userinfo&state={st}&email={quote(self.em)}"
              f"&logo_target=_blank&signup_target=_self&remind_target=_self")
        lu += (f"&cancel_page=https://o2.armgs.team/xlogin?client_id={cid}"
               f"&response_type=code&scope=&redirect_uri=https%3A%2F%2Fu.armgs.team%2Fapi%2Fv1%2Fidm%2Fauth%2Fcallback"
               f"&state={st}&login={quote(self.em)}&fail=1")
        lr = s.get(lu, timeout=20)
        act = s.cookies.get("act")
        if not act:
            raise RuntimeError(f"step3: нет cookie act ({list(s.cookies.keys())})")

        # Step 4 - POST формы авторизации (login/password)
        self.log("step4 POST auth form")
        ref = lr.history[-1].url if lr.history else "https://account.armgs.team/login"
        page_url = (f"https://o2.armgs.team/login?authid=m6kigbls.rbp&client_id={cid}&from=o2"
                    f"&login={quote(self.em)}"
                    f"&redirect_uri=https%3A%2F%2Fu.armgs.team%2Fapi%2Fv1%2Fidm%2Fauth%2Fcallback"
                    f"&response_type=code&scope=userinfo&state={st}")
        ar = s.post("https://auth.armgs.team/cgi-bin/auth", data={
            "username": self.em, "Login": self.em, "password": self.pw, "Password": self.pw,
            "new_auth_form": "1",
            "FromAccount": "opener=o2&x=login&twoSteps=1&remind_target=_self",
            "act_token": act, "page": page_url, "lang": "ru_RU",
        }, headers={"referer": ref}, timeout=60)
        last = ar.history[-1].url if ar.history else ar.url
        if "fail=" in last or "/xlogin" in last:
            raise RuntimeError(f"step4: вход отклонён (SDC/логин?): {last[:200]}")
        jitter()

        # Step 5 - свежий authorize c кодом
        self.log("step5 authorization code")
        ar2 = s.get(f"{U_HOST}/api/v125/idm/auth/authorize",
                    params={"client_id": "dGFybS13ZWIK", "response_type": "code",
                            "redirect_uri": f"{WEBIM_ORIGIN}/", "login_hint": self.em,
                            "state": "63548", "scope": "openid", "type": "SWA"},
                    timeout=20)
        code = ""
        for u in [resp.headers.get("location", "") or resp.url for resp in ar2.history] \
                + [ar2.url, ar2.headers.get("location", "")]:
            m = re.search(r"code=([^&]+)", u)
            if m:
                code = unquote(m.group(1))
                break
        if not code:
            raise RuntimeError(f"step5: нет authorization code (final={ar2.url[:200]})")
        self.log(f"  code={code[:30]}...")

        # Step 6 - повторный config
        self.log("step6 myteam-config (2nd)")
        r = s.get(f"{U_HOST}/myteam-config.json",
                  params={"r": str(int(time.time() * 1000)),
                          "domain": self.cfg["domain"], "email": self.cfg["user"]},
                  timeout=20)
        if r.status_code != 200:
            raise RuntimeError(f"step6 -> {r.status_code}")
        jitter()

        # Step 7 - обмен кода на access token
        self.log("step7 token exchange")
        tk = s.post(f"{U_HOST}/api/v125/idm/auth/token", data={
            "client_id": "dGFybS13ZWIK", "client_secret": "dGFybS13ZWIK",
            "grant_type": "authorization_code", "code": code, "state": "40914",
            "redirect_uri": f"{WEBIM_ORIGIN}/", "scope": "openid",
        }, timeout=20)
        tkd = tk.json()
        at = tkd.get("access_token") or tkd.get("id_token")
        if not at:
            raise RuntimeError(f"step7: нет токена в {json.dumps(tkd)[:200]}")
        self.token = at

        # Step 8 - startSession (aimsid)
        self.log("step8 startSession")
        ts = str(round(time.time() - 0.5))
        su = (f"{U_HOST}/api/v125/wim/aim/startSession?ts={ts}&userSn={quote(self.em)}"
              "&k=dGFybS13ZWIK&view=online&clientName=webVKTeams&language=ru-RU"
              "&deviceId=04fc70-36c6-ce86-d371-f7fbed8b8295&sessionTimeout=2592000"
              "&assertCaps=" + quote("094613584C7F11D18222444553540000,0946135C4C7F11D18222444553540000,0946135b4c7f11d18222444553540000,0946135E4C7F11D18222444553540000,AABC2A1AF270424598B36993C6231952,1f99494e76cbc880215d6aeab8e42268,A20C362CD4944B6EA3D1E77642201FD8,B5ED3E51C7AC4137B5926BC686E7A60D,094613504c7f11d18222444553540000,094613514c7f11d18222444553540000,094613564c7f11d18222444553540000,094613503c7f11d18222444553540000", safe="")
              + "&interestCaps=" + quote("8eec67ce70d041009409a7c1602a5c84,094613504c7f11d18222444553540000,094613514c7f11d18222444553540000,094613564c7f11d18222444553540000", safe="")
              + "&subscriptions=status"
              + "&events=myInfo,presence,buddylist,typing,hiddenChat,hist,mchat,sentIM,imState,dataIM,offlineIM,userAddedToBuddyList,service,lifestream,apps,permitDeny,diff,webrtcMsg"
              + "&includePresenceFields=aimId,displayId,friendly,friendlyName,state,userType,statusMsg,statusTime,ssl,mute,counterEnabled,abContactName,abPhoneNumber,abPhones,official,quiet,autoAddition,largeIconId,nick,userState")
        ss = s.post(su, headers={
            "content-type": "text/plain;charset=UTF-8",
            "authorization": "Bearer " + at,
            "origin": WEBIM_ORIGIN, "referer": WEBIM_ORIGIN + "/",
        }, timeout=20)
        ssd = ss.json()
        aid = ssd.get("response", {}).get("data", {}).get("aimsid")
        if not aid:
            raise RuntimeError(f"step8: нет aimsid в {json.dumps(ssd)[:200]}")
        self.aimsid = aid
        self.log(f"  aimsid={aid}")

    # ── сервисные методы ──────────────────────────────────
    def _aim_headers(self) -> dict:
        return {"x-teams-aimsid": self.aimsid,
                "origin": WEBIM_ORIGIN, "referer": WEBIM_ORIGIN + "/"}

    # ── загрузка файла ────────────────────────────────────
    def upload_file(self, path: str) -> tuple[str, str, str]:
        """Возвращает (fileid, static_url, filename)."""
        if not os.path.isfile(path):
            raise RuntimeError(f"файл не найден: {path}")
        size = os.path.getsize(path)
        name = os.path.basename(path)
        self.log(f"upload init: {name} ({size} bytes)")

        ini = self.s.get(f"{U_HOST}{API}/files/init",
                         params={"aimsid": self.aimsid, "ts": int(time.time()),
                                 "size": size, "filename": name, "client": "VKTeams"},
                         headers=self._aim_headers(), timeout=30)
        if ini.status_code != 200:
            raise RuntimeError(f"files/init -> {ini.status_code}: {ini.text[:200]}")
        res = ini.json()["result"]
        host, url = res["host"], res["url"]
        complete_url = res.get("complete_url") or url

        chunks = max(1, math.ceil(size / CHUNK_SIZE))
        result: dict = {}
        with open(path, "rb") as f:
            for i in range(chunks):
                start = i * CHUNK_SIZE
                chunk = f.read(CHUNK_SIZE)
                end = start + len(chunk) - 1
                is_last = i == chunks - 1
                target_url = complete_url if (chunks > 1 and is_last) else url
                r = self.s.post(f"https://{host}{target_url}", params={"aimsid": self.aimsid},
                               data=chunk, timeout=300,
                               headers={**self._aim_headers(),
                                        "content-type": "application/octet-stream",
                                        "content-range": f"bytes {start}-{end}/{size}",
                                        "content-disposition": f'attachment; filename="{name}"',
                                        "x-requested-with": "XMLHttpRequest"})
                if r.status_code != 200:
                    raise RuntimeError(f"upload chunk {i + 1}/{chunks} -> {r.status_code}: {r.text[:200]}")
                try:
                    if r.json().get("result"):
                        result = r.json()["result"]
                except ValueError:
                    pass
                self.log(f"  chunk {i + 1}/{chunks}: {len(chunk)} bytes -> {r.status_code}")
                if not is_last:
                    time.sleep(0.15)

        fileid = result.get("fileid")
        static_url = result.get("static_url")
        if not fileid or not static_url:
            raise RuntimeError(f"upload: в ответе нет fileid/static_url: {json.dumps(result)[:200]}")

        # Подтверждение (как в веб-клиенте)
        try:
            info = self.s.get(f"{U_HOST}{API}/files/info/{fileid}/",
                             params={"aimsid": self.aimsid, "previews": "192,600,800,xlarge"},
                             headers=self._aim_headers(), timeout=30)
            if info.status_code == 200:
                self.log("  files/info OK")
        except requests.RequestException as e:
            self.log(f"  files/info: предупреждение ({e})")
        return fileid, static_url, name

    # ── отправка ──────────────────────────────────────────
    def _sendim(self, to: str, parts: list[dict]) -> dict:
        data = {
            "t": to,
            "r": request_id(),
            "parts": json.dumps(parts, ensure_ascii=False),
            "f": "json",
            "aimsid": self.aimsid,
        }
        r = self.s.post(f"{U_HOST}{API}/wim/im/sendIM", data=data,
                        headers=self._aim_headers(), timeout=60)
        if r.status_code != 200:
            raise RuntimeError(f"sendIM -> {r.status_code}: {r.text[:200]}")
        try:
            body = r.json()
        except ValueError:
            return {}
        resp = body.get("response", body) if isinstance(body, dict) else {}
        if not resp:
            return {}
        if resp.get("statusCode") not in (200, None):
            raise RuntimeError(f"sendIM: статус {resp.get('statusText')!r}")
        data = resp.get("data", {}) if isinstance(resp.get("data"), dict) else {}
        return {"msgId": data.get("msgId"), "state": data.get("state") or resp.get("state")}

    def _maybe_pdfify(self, path: str) -> tuple[str, str]:
        """Текстовое вложение → PDF. Возвращает (путь_к_файлу, имя_в_сообщении);
        при недоступности конвертера — оригинал."""
        ext = os.path.splitext(path)[1].lower()
        if ext not in PDFIFY_EXTS or not os.path.isfile(path):
            return path, os.path.basename(path)
        node = shutil.which("node")
        if not node or not os.path.isfile(MD2PDF):
            self.log("PDF-конвертер недоступен (node/md2pdf.cjs) — отправляю оригинал")
            return path, os.path.basename(path)
        stem = os.path.basename(path)[:-len(ext)] or "file"
        out = os.path.join(tempfile.gettempdir(),
                           f"sreda_pdf_{int(time.time() * 1000)}_{stem}.pdf")
        try:
            r = subprocess.run([node, MD2PDF, path, out], capture_output=True,
                               text=True, timeout=180)
            if r.returncode != 0 or not os.path.isfile(out) or os.path.getsize(out) < 500:
                raise RuntimeError((r.stderr or r.stdout or "пустой вывод").strip()[:300])
            display = f"{stem}.pdf"
            self.log(f"конвертация {os.path.basename(path)} -> {display} ({os.path.getsize(out)} B)")
            return out, display
        except Exception as e:  # noqa: BLE001
            self.log(f"конвертация в PDF не удалась ({e}) — отправляю оригинал")
            if os.path.isfile(out):
                try: os.remove(out)
                except OSError: pass
            return path, os.path.basename(path)

    def send(self, recipients: list[str], text: str = "", files: list[str] | None = None,
             pdfify: bool = True) -> list[dict]:
        """Отправка одного сообщения (текст и/или вложения) всем recipients. Возвращает отчёты."""
        files = files or []
        out: list[dict] = []
        if files:
            parts: list[dict] = []
            if text:
                parts.append({"mediaType": "text", "text": text})
            tmp_made: list[str] = []
            names: list[str] = []
            try:
                for fp in files:
                    src, display = (self._maybe_pdfify(fp) if pdfify
                                    else (fp, os.path.basename(fp)))
                    if src != fp:
                        tmp_made.append(src)
                    fileid, static_url, _name = self.upload_file(src)
                    names.append(display)
                    parts.append({"mediaType": "text", "text": "",
                                  "captionedContent": {"caption": display, "url": static_url}})
            finally:
                for t in tmp_made:
                    try: os.remove(t)
                    except OSError: pass
        else:
            if not text:
                raise ValueError("нечего отправлять: нужны --text и/или --attach")
            parts = [{"mediaType": "text", "text": text}]
            names = []

        for raw in recipients:
            to = norm_recipient(raw, self.cfg["domain"])
            resp = self._sendim(to, parts)
            ok = True
            note = f"msgId={resp.get('msgId' or '-')} state={resp.get('state') or 'n/a'}"
            out.append({"to": to, "ok": ok, "note": note, "files": names})
            self.log(f"sent -> {to}: {note}")
            time.sleep(0.2)
        return out


# ─────────────────────────────────────────────── CLI

def build_client(cfg: dict, verbose: bool, force_token: bool = False) -> tuple[SredaClient, bool]:
    """Возвращает (клиент, выполнен ли fresh-login)."""
    st = None if force_token else load_state(cfg)
    c = SredaClient(cfg, state=st, verbose=verbose)
    fresh = not bool(st)
    if fresh:
        c.log("state нет/протух — cold OAuth")
        c.login()
        save_state(cfg, {"token": c.token, "aimsid": c.aimsid,
                         "expiryMs": now_ms() + TOKEN_TTL_SEC * 1000, "email": c.em})
        c.log(f"state сохранён: {get_state_path(cfg)}")
    else:
        c.log(f"используется кэш state: {st['aimsid'][:40]}...")
    return c, fresh


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="sreda_send",
                                description="Отправка сообщений в «Среду» (armgs) с вложениями")
    p.add_argument("--config", default=DEFAULT_CONFIG, help="путь к config.json")
    sub = p.add_subparsers(dest="cmd", required=True)

    pt = sub.add_parser("token", help="принудительно обновить токен (cold OAuth)")
    pt.add_argument("--verbose", action="store_true", help="подробный лог на stderr")

    ps = sub.add_parser("send", help="отправить сообщение")
    ps.add_argument("--to", action="append", required=True, metavar="USER",
                    help="получатель (можно повторять, без @rosstat.gov.ru)")
    ps.add_argument("--text", default="", help="текст сообщения")
    ps.add_argument("--attach", action="append", default=[], metavar="FILE",
                    help="файл-вложение (можно повторять)")
    ps.add_argument("--no-pdf", dest="pdfify", action="store_false",
                    help="не конвертировать md/txt-вложения в PDF (по умолчанию конвертируют)")
    ps.add_argument("--verbose", action="store_true",
                    help="подробный лог на stderr (по умолчанию тише)")
    a = p.parse_args(argv)
    cfg = load_config(a.config)

    try:
        c, _ = build_client(cfg, verbose=a.verbose, force_token=(a.cmd == "token"))
        if a.cmd == "token":
            print(json.dumps({"ok": True, "refreshed": True,
                              "state": get_state_path(cfg)}, ensure_ascii=False))
            return 0
        pdfify = a.pdfify and not os.environ.get("SREDAS_NO_PDF")
        report = c.send(a.to, text=a.text, files=a.attach, pdfify=pdfify)
        ok = all(r["ok"] for r in report)
        print(json.dumps({"ok": ok, "sent": report}, ensure_ascii=False))
        return 0 if ok else 1
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        print(f"ОШИБКА: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
