"""Free-LLM router: rotates between providers and models so clip picking never stops.
Order: every provider with a key -> local GPU model -> (caller) rule-based picker."""
import random
import re
import threading
import time

import requests

from . import config
from .utils import get_secret

#
# Order: every provider you added a key for → local GPU model → rule-based picker.
# When a model hits a rate limit (HTTP 429) it is put on cooldown and the next one is used.
# Each model has its own separate free limit, so rotating models also multiplies your free usage.

PROVIDERS = [
    # name, secret, base_url, preferred models (auto-discovered if these change)
    {"name": "anthropic", "key": "ANTHROPIC_API_KEY", "base": "https://api.anthropic.com/v1",
     "models": ["claude-sonnet-5-5", "claude-haiku-5-5"]},
    {"name": "groq", "key": "GROQ_API_KEY", "base": "https://api.groq.com/openai/v1",
     "models": ["llama-3.3-70b-versatile", "openai/gpt-oss-120b", "qwen/qwen3-32b",
                "meta-llama/llama-4-scout-17b-16e-instruct", "openai/gpt-oss-20b", "llama-3.1-8b-instant"]},
    {"name": "gemini", "key": "GEMINI_API_KEY", "base": "https://generativelanguage.googleapis.com/v1beta/openai",
     "models": ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash"]},
    {"name": "cerebras", "key": "CEREBRAS_API_KEY", "base": "https://api.cerebras.ai/v1",
     "models": ["gpt-oss-120b", "llama-3.3-70b", "qwen-3-32b", "llama3.1-8b"]},
    {"name": "mistral", "key": "MISTRAL_API_KEY", "base": "https://api.mistral.ai/v1",
     "models": ["mistral-small-latest", "open-mistral-nemo", "mistral-medium-latest"]},
    {"name": "openrouter", "key": "OPENROUTER_API_KEY", "base": "https://openrouter.ai/api/v1",
     "models": []},  # filled automatically with every currently-free model
]

_SKIP_WORDS = ("whisper", "tts", "guard", "embed", "audio", "image", "vision", "moderation",
               "orpheus", "playai", "compound", "transcribe", "ocr", "realtime")


class LLMRouter:
    def __init__(self, providers, use_local=True, verbose=True):
        self.verbose = verbose
        self.log_fn = None
        self.use_local = use_local
        self.routes = []          # list of dicts: provider, model, api_key, base
        self.cooldown = {}        # (provider, model) -> unix time when usable again
        self.dead = set()         # permanently broken routes
        self.local_pipe = None
        self.stats = {}
        self.no_extras = set()    # routes that reject reasoning_effort / response_format
        self.last_finish = None
        for p in providers:
            key = get_secret(p["key"])
            if not key:
                continue
            models = self._discover(p, key)
            for m in models:
                self.routes.append({"provider": p["name"], "model": m, "key": key, "base": p["base"]})
        names = sorted({r["provider"] for r in self.routes})
        self.log(f"LLM routes: {len(self.routes)} models across {names or 'no API providers'}"
                 + (" + local model" if use_local else "") + " + rule-based fallback")

    def log(self, *a):
        msg = " ".join(str(x) for x in a)
        if self.log_fn:
            self.log_fn(msg)
        elif self.verbose:
            print(msg)

    def _discover(self, p, key):
        """Keep preferred models that still exist; if none exist, use what the provider lists now."""
        preferred = list(p["models"])
        if p["name"] == "anthropic":
            return preferred
        try:
            r = requests.get(p["base"] + "/models", headers={"Authorization": f"Bearer {key}"}, timeout=20)
            r.raise_for_status()
            data = r.json().get("data", [])
        except Exception as e:
            self.log(f"  {p['name']}: could not list models ({e.__class__.__name__}); using defaults")
            return preferred
        if p["name"] == "openrouter":
            free = []
            for m in data:
                pr = m.get("pricing") or {}
                if str(pr.get("prompt")) in ("0", "0.0") and str(pr.get("completion")) in ("0", "0.0") \
                        and (m.get("context_length") or 0) >= 16000:
                    if not any(s in m["id"].lower() for s in _SKIP_WORDS):
                        free.append((m.get("context_length") or 0, m["id"]))
            free.sort(reverse=True)
            return [mid for _, mid in free[:12]]
        avail = [str(m.get("id", "")).replace("models/", "") for m in data]
        avail = [a for a in avail if a and not any(s in a.lower() for s in _SKIP_WORDS)]
        keep = [m for m in preferred if m in avail]
        # add other models the provider offers right now → more separate free limits to rotate through
        extra = [a for a in avail if a not in keep]
        if p["name"] == "gemini":
            extra = [a for a in extra if "gemini" in a and "flash" in a]  # flash models have the free tier
        return keep + extra[:max(0, 6 - len(keep))]

    # ---------- calling ----------
    @staticmethod
    def _is_reasoning(model):
        m = model.lower()
        return any(k in m for k in ("gpt-oss", "gemini-2.5", "gemini-3", "qwen3", "qwq", "deepseek-r", "magistral",
                                    "reasoning", "thinking", "o3", "o4"))

    def _call_openai_style(self, route, system, user, max_tokens):
        headers = {"Authorization": f"Bearer {route['key']}", "Content-Type": "application/json"}
        if route["provider"] == "openrouter":
            headers["X-Title"] = "Clipora"
        body = {"model": route["model"], "temperature": 0.4,
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
        rid = (route["provider"], route["model"])
        if self._is_reasoning(route["model"]):
            # "thinking" models spend tokens on hidden reasoning first; with a small limit the answer
            # gets cut off before the JSON is written. Give them room and ask for light thinking.
            body["max_tokens"] = max(max_tokens, 12000)
            if rid not in self.no_extras:
                body["reasoning_effort"] = "low"
        else:
            body["max_tokens"] = max_tokens
        if rid not in self.no_extras:
            body["response_format"] = {"type": "json_object"}
        r = requests.post(route["base"] + "/chat/completions", headers=headers, json=body, timeout=240)
        if r.status_code in (400, 422) and rid not in self.no_extras:
            # this model doesn't accept the extra options → remember and retry plainly
            self.no_extras.add(rid)
            body.pop("reasoning_effort", None)
            body.pop("response_format", None)
            r = requests.post(route["base"] + "/chat/completions", headers=headers, json=body, timeout=240)

        def extract(j):
            ch = (j.get("choices") or [{}])[0]
            self.last_finish = ch.get("finish_reason")
            return (ch.get("message") or {}).get("content") or ""
        return r, extract

    def _call_anthropic(self, route, system, user, max_tokens):
        headers = {"x-api-key": route["key"], "anthropic-version": "2023-06-01", "content-type": "application/json"}
        body = {"model": route["model"], "max_tokens": max_tokens, "temperature": 0.4, "system": system,
                "messages": [{"role": "user", "content": user}]}
        r = requests.post(route["base"] + "/messages", headers=headers, json=body, timeout=180)
        return r, (lambda j: "".join(b.get("text", "") for b in j.get("content", []) if b.get("type") == "text"))

    @staticmethod
    def _retry_after(resp, default=60.0):
        for h in ("retry-after", "x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"):
            v = resp.headers.get(h)
            if not v:
                continue
            try:
                return float(v)
            except ValueError:
                m = re.match(r"(?:(\d+)m)?([\d.]+)s", v)
                if m:
                    return float(m.group(1) or 0) * 60 + float(m.group(2))
        return default

    def chat(self, system, user, max_tokens=2500, validate=None):
        """Try every route until one returns text that passes `validate` (if given)."""
        for attempt in range(3):
            now = time.time()
            ready = [r for r in self.routes if (r["provider"], r["model"]) not in self.dead
                     and self.cooldown.get((r["provider"], r["model"]), 0) <= now]
            for route in ready:
                rid = (route["provider"], route["model"])
                try:
                    fn = self._call_anthropic if route["provider"] == "anthropic" else self._call_openai_style
                    resp, extract = fn(route, system, user, max_tokens)
                    if resp.status_code == 429:
                        wait = self._retry_after(resp)
                        self.cooldown[rid] = time.time() + max(wait, 10)
                        self.log(f"  ⏳ {rid[0]}/{rid[1]} rate-limited, cooling {wait:.0f}s → next")
                        continue
                    if resp.status_code in (401, 403):
                        self.dead.update((r["provider"], r["model"]) for r in self.routes
                                         if r["provider"] == route["provider"])
                        self.log(f"  🔑 {rid[0]} key rejected ({resp.status_code}) → skipping this provider")
                        continue
                    if resp.status_code == 404:  # model retired / not available for this key
                        self.dead.add(rid)
                        self.log(f"  🚫 {rid[0]}/{rid[1]} not available (404) → removed")
                        continue
                    if resp.status_code in (400, 413, 422):
                        self.cooldown[rid] = time.time() + 600
                        self.log(f"  ⚠️ {rid[0]}/{rid[1]} error {resp.status_code}: {resp.text[:150]} → next")
                        continue
                    if resp.status_code >= 500:
                        self.cooldown[rid] = time.time() + 30
                        self.log(f"  ⚠️ {rid[0]}/{rid[1]} server error {resp.status_code} → next")
                        continue
                    self.last_finish = None
                    text = extract(resp.json())
                    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()
                    if validate and validate(text) is None:
                        self.cooldown[rid] = time.time() + 60
                        why = "answer was cut off (too long)" if self.last_finish == "length" else \
                              "empty answer" if not text else "no valid clips in: " + text[:120].replace("\n", " ")
                        self.log(f"  ⚠️ {rid[0]}/{rid[1]} unusable output ({why}) → next")
                        continue
                    self.stats[rid] = self.stats.get(rid, 0) + 1
                    self.log(f"  ✅ answered by {rid[0]}/{rid[1]}")
                    return text
                except requests.RequestException as e:
                    self.cooldown[rid] = time.time() + 30
                    self.log(f"  ⚠️ {rid[0]}/{rid[1]} network error {e.__class__.__name__} → next")
            # all API routes busy: wait briefly if one frees up soon, else go local
            pending = [t for k, t in self.cooldown.items() if k not in self.dead and t > time.time()]
            soon = min(pending) - time.time() if pending else None
            if soon is not None and soon <= 65 and attempt < 2:
                self.log(f"  ⏳ all APIs busy, waiting {soon:.0f}s...")
                time.sleep(max(soon, 1))
                continue
            break
        if self.use_local:
            text = self._local(system, user, max_tokens)
            if text and (validate is None or validate(text) is not None):
                self.log("  ✅ answered by local model")
                return text
        return None  # caller falls back to the rule-based picker

    def _local(self, system, user, max_tokens):
        if not config.has_gpu():
            return None
        import torch
        try:
            if self.local_pipe is None:
                self.log(f"  🖥️ loading local model {config.LOCAL_LLM_MODEL} (first time takes a few minutes)...")
                from transformers import pipeline
                try:
                    self.local_pipe = pipeline("text-generation", model=config.LOCAL_LLM_MODEL,
                                               dtype=torch.float16, device_map="auto")
                except TypeError:  # older transformers
                    self.local_pipe = pipeline("text-generation", model=config.LOCAL_LLM_MODEL,
                                               torch_dtype=torch.float16, device_map="auto")
            out = self.local_pipe([{"role": "system", "content": system}, {"role": "user", "content": user}],
                                  max_new_tokens=min(max_tokens, 1500), do_sample=False)
            return out[0]["generated_text"][-1]["content"]
        except Exception as e:
            self.log(f"  ⚠️ local model failed: {e}")
            self.use_local = False
            return None


_router = None
_router_lock = threading.Lock()


def get_router(log_fn=None):
    """One shared router for the whole server (keeps cooldowns and the local model loaded)."""
    global _router
    with _router_lock:
        if _router is None:
            _router = LLMRouter(PROVIDERS, use_local=config.USE_LOCAL_LLM)
        _router.log_fn = log_fn
        return _router


def provider_status():
    """Key present? + live state from the router (rate limits / rejected keys) when it has been used."""
    from .utils import get_secret as gs
    now = time.time()
    out = []
    for p in PROVIDERS:
        item = {"name": p["name"], "has_key": bool(gs(p["key"])), "secret": p["key"], "state": "no_key"}
        if item["has_key"]:
            item["state"] = "ready"
            r = _router
            if r is not None:
                routes = [(x["provider"], x["model"]) for x in r.routes if x["provider"] == p["name"]]
                live = [k for k in routes if k not in r.dead]
                item["models"] = len(live)
                item["answers"] = sum(r.stats.get(k, 0) for k in routes)
                if routes and not live:
                    item["state"] = "rejected"
                elif live and all(r.cooldown.get(k, 0) > now for k in live):
                    item["state"] = "cooldown"
                    item["cooldown_s"] = round(min(r.cooldown[k] for k in live) - now)
        out.append(item)
    return out
