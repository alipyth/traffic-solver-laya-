"""Decision brains for the traffic lights.

Pipeline for every intersection (the same for every brain):

    browser sensors  ->  sensor fusion (pressure per axis)  ->  short English sentence
                     ->  brain answers "ns" or "ew"          ->  browser switches the lights

Laya is a non-autoregressive *encoder* (ModernBERT, 512-token context). It answers typed
questions over a short state in one forward pass; it does not do arithmetic well. So the
sensor layer turns raw counts into qualitative bands ("light", "heavy", ...) and Laya decides
which road gets green, with emergency vehicles taking priority. One state per intersection,
all intersections scored in a single `predict_batch` call.
"""
from __future__ import annotations

import asyncio
import json
import os
import threading
import time
from collections import OrderedDict
from typing import Any, Dict, List, Optional, Tuple

import httpx

DIRS = ("N", "S", "E", "W")
AXIS_DIRS = {"ns": ("N", "S"), "ew": ("E", "W")}
AXIS_EN = {"ns": "north-south", "ew": "east-west"}

LAYA_QUESTION = {
    "green": {
        "type": "choice",
        "instructions": "Give the green light to the busier road; an ambulance always gets green first.",
        "criteria": {"ns": "north-south road", "ew": "east-west road"},
    }
}


# --------------------------------------------------------------------------- sensor fusion

def _get(d: Optional[Dict[str, float]], k: str, default: float = 0.0) -> float:
    try:
        return float((d or {}).get(k, default) or 0.0)
    except (TypeError, ValueError):
        return default


def exit_factor(occupancy: float) -> float:
    """How much of an approach's queue can actually leave: 1 when the road ahead is clear."""
    if occupancy <= 0.5:
        return 1.0
    return max(0.1, (1.0 - occupancy) / 0.5)


def approach_pressure(s: Dict[str, Any], d: str) -> float:
    q = _get(s.get("queues"), d) + 0.4 * _get(s.get("approaching"), d) + _get(s.get("wait"), d) / 20.0
    q *= exit_factor(_get(s.get("downstream"), d))
    if s.get("blocked_dir") == d:
        q *= 0.15
    return q


def axis_pressure(s: Dict[str, Any]) -> Dict[str, float]:
    return {ax: sum(approach_pressure(s, d) for d in ds) for ax, ds in AXIS_DIRS.items()}


def band(p: float) -> str:
    if p < 0.8:
        return "empty"
    if p < 4:
        return "light"
    if p < 9:
        return "moderate"
    if p < 16:
        return "heavy"
    return "severely jammed"


def emergency_axis(s: Dict[str, Any]) -> Optional[str]:
    d = s.get("emergency_dir")
    if d in ("N", "S"):
        return "ns"
    if d in ("E", "W"):
        return "ew"
    return None


BANDS = ("empty", "light", "moderate", "heavy", "severely jammed")


def compose_text(band_ns: str, band_ew: str, busier: Optional[str], ambulance: Optional[str]) -> str:
    text = f"North-south traffic is {band_ns}. East-west traffic is {band_ew}."
    # Laya is an encoder, not a calculator: comparing two band words alone it favours whichever road is
    # named first (~75% on all pairs). Stating the comparison explicitly makes it 75/75, including the
    # cases where an ambulance must override it.
    text += f" More cars are waiting on the {AXIS_EN[busier]} road." if busier else " Both roads are equally busy."
    if ambulance:
        text += f" An ambulance is coming on the {AXIS_EN[ambulance]} road."
    return text


def all_texts() -> List[str]:
    """Every sentence the sensor layer can produce (105): small enough to pre-compute once."""
    out = []
    for i, bn in enumerate(BANDS):
        for j, be in enumerate(BANDS):
            options = ["ns" if i > j else "ew"] if i != j else ["ns", "ew", None]
            for busier in options:
                for amb in (None, "ns", "ew"):
                    out.append(compose_text(bn, be, busier, amb))
    return out


def state_text(s: Dict[str, Any]) -> str:
    """The exact sentence Laya reads for one intersection."""
    p = axis_pressure(s)
    busier = None if abs(p["ns"] - p["ew"]) <= 0.3 else ("ns" if p["ns"] > p["ew"] else "ew")
    return compose_text(band(p["ns"]), band(p["ew"]), busier, emergency_axis(s))


BAND_FA = {"empty": "خالی", "light": "خلوت", "moderate": "متوسط", "heavy": "سنگین", "severely jammed": "خیلی سنگین"}
AXIS_FA = {"ns": "شمال–جنوب", "ew": "شرق–غرب"}


def state_fa(s: Dict[str, Any]) -> str:
    """Persian translation of exactly what Laya reads (for the UI)."""
    p = axis_pressure(s)
    parts = [f"خیابان شمال–جنوب {BAND_FA[band(p['ns'])]}", f"خیابان شرق–غرب {BAND_FA[band(p['ew'])]}"]
    if abs(p["ns"] - p["ew"]) > 0.3:
        parts.append(f"صف {AXIS_FA['ns' if p['ns'] > p['ew'] else 'ew']} بیشتر است")
    else:
        parts.append("هر دو یکسان‌اند")
    em = emergency_axis(s)
    if em:
        parts.append(f"🚑 آمبولانس در خیابان {AXIS_FA[em]}")
    return "، ".join(parts) + "."


def reference_axis(s: Dict[str, Any]) -> str:
    """Transparent rule used as a reference line (and as fallback when Laya is unavailable)."""
    em = emergency_axis(s)
    if em:
        return em
    p = axis_pressure(s)
    if abs(p["ns"] - p["ew"]) <= 0.3:
        return s.get("green_axis") or "ns"
    return "ns" if p["ns"] > p["ew"] else "ew"


def reason_fa(s: Dict[str, Any], axis: str) -> str:
    p = axis_pressure(s)
    em = emergency_axis(s)
    if em and em == axis:
        return f"سبز برای {AXIS_FA[axis]}، چون آمبولانس در این خیابان است."
    if abs(p["ns"] - p["ew"]) <= 0.3:
        return f"دو خیابان هم‌اندازه شلوغ‌اند؛ {AXIS_FA[axis]} را انتخاب کرد."
    busier = "ns" if p["ns"] > p["ew"] else "ew"
    if busier == axis:
        return f"سبز برای {AXIS_FA[axis]}، چون صف آن بیشتر است."
    return f"سبز برای {AXIS_FA[axis]}، برخلاف صف بیشتر در {AXIS_FA[busier]}."


def _decision(s: Dict[str, Any], axis: str, probs: Dict[str, float], text: str) -> Dict[str, Any]:
    em = emergency_axis(s)
    return {
        "axis": axis,
        "phase": "EMERGENCY_PRIORITY" if em and em == axis else ("NS_GREEN" if axis == "ns" else "EW_GREEN"),
        "probabilities": probs,
        "confidence": float(probs.get(axis, 0.0)) if probs else 0.0,
        "state_text": text,
        "state_fa": state_fa(s),
        "reference": reference_axis(s),
        "pressure": {k: round(v, 2) for k, v in axis_pressure(s).items()},
        "reason": reason_fa(s, axis),
    }


# --------------------------------------------------------------------------- brains

class LayaBrain:
    name = "laya"

    def __init__(self, model_id: Optional[str] = None):
        self.model_id = model_id or os.getenv("LAYA_MODEL", "convaiinnovations/laya")
        self.agent = None
        self.status = "idle"  # idle | loading | ready | error
        self.error: Optional[str] = None
        self.device = None
        self._load_lock = threading.Lock()
        self._predict_lock = threading.Lock()
        # Laya is deterministic: the same sentence always gets the same answer. Only sentences the
        # model has not seen yet are sent to it, so most decision rounds finish in milliseconds.
        self._cache: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
        self.last_stats = {"fresh": 0, "cached": 0, "model_ms": 0.0}
        self.prewarm = {"done": 0, "total": 0}
        self.model_ms_samples: List[float] = []

    def load(self) -> None:
        with self._load_lock:
            if self.status in ("ready", "error"):
                return
            self.status = "loading"
            try:
                import laya

                agent = laya.load(self.model_id)
                agent.predict_batch([state_text({"queues": {"N": 3}})], LAYA_QUESTION)  # warm-up
                self.agent = agent
                self.device = str(getattr(agent, "device", "cpu"))
                self.status = "ready"
                threading.Thread(target=self._prewarm, daemon=True).start()
            except Exception as e:  # pragma: no cover - depends on environment
                self.error = f"{type(e).__name__}: {e}"
                self.status = "error"

    def _prewarm(self) -> None:
        """Answer every possible sentence once, in small chunks so live requests can interleave."""
        todo = [t for t in all_texts() if t not in self._cache]
        self.prewarm = {"done": 0, "total": len(todo)}
        for k in range(0, len(todo), 6):
            chunk = todo[k:k + 6]
            t0 = time.perf_counter()
            with self._predict_lock:
                results = self.agent.predict_batch(chunk, LAYA_QUESTION)
            self._record_model_ms((time.perf_counter() - t0) * 1000 / len(chunk))
            for t, r in zip(chunk, results):
                self._cache[t] = r["answers"]["green"]
            self.prewarm["done"] = min(len(todo), k + len(chunk))

    def _record_model_ms(self, per_sentence_ms: float) -> None:
        self.model_ms_samples.append(per_sentence_ms)
        del self.model_ms_samples[:-50]

    @property
    def model_ms_per_sentence(self) -> Optional[float]:
        m = self.model_ms_samples
        return round(sum(m) / len(m), 1) if m else None

    def _decide_sync(self, states: List[Dict[str, Any]]) -> Tuple[Dict[str, Dict], str]:
        texts = [state_text(s) for s in states]
        if self.status != "ready":
            self.load()
        if self.agent is None:
            out = {}
            for s, t in zip(states, texts):
                ax = reference_axis(s)
                out[s["id"]] = _decision(s, ax, {ax: 1.0}, t)
            return out, "reference-fallback"
        fresh = [t for t in dict.fromkeys(texts) if t not in self._cache]
        model_ms = 0.0
        if fresh:
            t0 = time.perf_counter()
            with self._predict_lock:
                results = self.agent.predict_batch(fresh, LAYA_QUESTION)
            model_ms = (time.perf_counter() - t0) * 1000
            self._record_model_ms(model_ms / len(fresh))
            for t, r in zip(fresh, results):
                self._cache[t] = r["answers"]["green"]
        self.last_stats = {"fresh": len(fresh), "cached": len(texts) - len(fresh), "model_ms": round(model_ms, 1)}
        out = {}
        for s, t in zip(states, texts):
            a = self._cache[t]
            out[s["id"]] = _decision(s, a["choice"], a["probabilities"], t)
        return out, "laya"

    def predict_raw(self, state: Any, questions: Dict[str, Any]) -> Dict[str, Any]:
        """Any state + any typed questions, straight to the model (used by the /laya playground)."""
        if self.status != "ready":
            self.load()
        if self.agent is None:
            raise RuntimeError(self.error or "Laya is not loaded")
        with self._predict_lock:
            return self.agent.predict(state, questions)

    async def decide(self, states: List[Dict[str, Any]]) -> Tuple[Dict[str, Dict], float, str]:
        t = time.perf_counter()
        out, source = await asyncio.to_thread(self._decide_sync, states)
        return out, (time.perf_counter() - t) * 1000, source


def parse_json_object(raw: str) -> Dict[str, Any]:
    raw = (raw or "").strip()
    if raw.startswith("```"):
        raw = raw.replace("```json", "").replace("```", "").strip()
    try:
        return json.loads(raw)
    except Exception:
        a, b = raw.find("{"), raw.rfind("}")
        if a >= 0 and b > a:
            return json.loads(raw[a:b + 1])
        raise


class LLMBrain:
    name = "llm"

    def __init__(self):
        self.settings = {"provider": "none", "base_url": "", "model": "", "api_key": ""}
        self.last_error: Optional[str] = None

    def configure(self, settings: Dict[str, str]):
        self.settings.update(settings)

    @property
    def ready(self) -> bool:
        return self.settings.get("provider") in {"ollama", "openai"} and bool(self.settings.get("model"))

    def prompt(self, states: List[Dict[str, Any]]) -> str:
        rows = {s["id"]: state_text(s) for s in states}
        return (
            "You control traffic lights. For each intersection choose which road gets the green light: "
            "\"ns\" (north-south) or \"ew\" (east-west). Give green to the busier road; an ambulance always "
            "gets green first. Return ONLY JSON like {\"decisions\": {\"A1\": \"ns\"}}.\n"
            f"Intersections: {json.dumps(rows)}"
        )

    async def _ollama(self, prompt: str) -> str:
        base = (self.settings.get("base_url") or "http://localhost:11434").rstrip("/")
        async with httpx.AsyncClient(timeout=60) as c:
            r = await c.post(base + "/api/chat", json={
                "model": self.settings["model"], "stream": False, "format": "json",
                "messages": [{"role": "user", "content": prompt}]})
            r.raise_for_status()
            return r.json()["message"]["content"]

    async def _openai(self, prompt: str) -> str:
        base = (self.settings.get("base_url") or "https://api.openai.com/v1").rstrip("/")
        headers = {"Content-Type": "application/json"}
        if self.settings.get("api_key"):
            headers["Authorization"] = "Bearer " + self.settings["api_key"]
        payload = {"model": self.settings["model"], "temperature": 0,
                   "messages": [{"role": "user", "content": prompt}],
                   "response_format": {"type": "json_object"}}
        async with httpx.AsyncClient(timeout=60) as c:
            r = await c.post(base + "/chat/completions", headers=headers, json=payload)
            if r.status_code in (400, 404, 422):
                payload.pop("response_format", None)
                r = await c.post(base + "/chat/completions", headers=headers, json=payload)
            r.raise_for_status()
            return r.json()["choices"][0]["message"]["content"]

    async def decide(self, states: List[Dict[str, Any]]) -> Tuple[Dict[str, Dict], float, str]:
        if not self.ready:
            return {}, 0.0, "llm-disabled"
        t = time.perf_counter()
        try:
            p = self.prompt(states)
            raw = await (self._ollama(p) if self.settings["provider"] == "ollama" else self._openai(p))
            data = parse_json_object(raw)
            d = data.get("decisions", data)
            out = {}
            for s in states:
                v = d.get(s["id"])
                if isinstance(v, dict):
                    v = v.get("axis") or v.get("green") or v.get("phase")
                v = str(v or "").lower()
                ax = "ns" if v.startswith("ns") or "north" in v else "ew" if v.startswith("ew") or "east" in v else None
                if ax is None:
                    continue  # unusable answer: the light keeps its current state
                out[s["id"]] = _decision(s, ax, {}, state_text(s))
            return out, (time.perf_counter() - t) * 1000, "llm"
        except Exception as e:
            self.last_error = f"{type(e).__name__}: {e}"
            return {}, (time.perf_counter() - t) * 1000, "llm-error"
