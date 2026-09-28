from __future__ import annotations

import asyncio
import json
import os
import random
import time
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .brains import DIRS, LAYA_QUESTION, LayaBrain, LLMBrain, reference_axis, state_text

BASE = Path(__file__).resolve().parent
laya = LayaBrain()
llm = LLMBrain()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Load Laya in the background so the page is usable immediately and the first decision is fast.
    if os.getenv("LAYA_PRELOAD", "1") != "0":
        threading.Thread(target=laya.load, daemon=True).start()
    yield


app = FastAPI(title="Traffic AI Lab", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=BASE / "static"), name="static")


class Sensors(BaseModel):
    """What the browser's road sensors measured at one intersection."""
    id: str
    queues: Dict[str, float] = Field(default_factory=dict)       # stopped cars per approach
    approaching: Dict[str, float] = Field(default_factory=dict)  # moving cars on the approach
    wait: Dict[str, float] = Field(default_factory=dict)         # longest wait per approach (s)
    downstream: Dict[str, float] = Field(default_factory=dict)   # exit-road occupancy 0..1
    emergency_dir: Optional[str] = None
    blocked_dir: Optional[str] = None
    green_axis: Optional[Literal["ns", "ew"]] = None


class DecideRequest(BaseModel):
    brain: Literal["laya", "llm"] = "laya"
    intersections: List[Sensors]


class LLMSettings(BaseModel):
    provider: str = "none"
    base_url: str = ""
    model: str = ""
    api_key: str = ""


@app.get("/")
def root():
    return FileResponse(BASE / "static" / "index.html")


@app.get("/laya")
def laya_page():
    return FileResponse(BASE / "static" / "laya.html")


class PlaygroundRequest(BaseModel):
    state: Any
    questions: Dict[str, Any]


@app.post("/api/laya/predict")
async def laya_predict(req: PlaygroundRequest):
    """General-purpose Laya call for the playground page: any text/JSON state, any typed questions."""
    if not req.questions or len(req.questions) > 16:
        return JSONResponse({"error": "بین ۱ تا ۱۶ سؤال بفرست."}, status_code=400)
    if len(json.dumps(req.state, ensure_ascii=False)) > 6000:
        return JSONResponse({"error": "متن ورودی بیش از ۶۰۰۰ نویسه است."}, status_code=400)
    t = time.perf_counter()
    try:
        result = await asyncio.to_thread(laya.predict_raw, req.state, req.questions)
    except ValueError as e:  # malformed question definitions: Laya names the question and the fix
        return JSONResponse({"error": str(e)}, status_code=400)
    except RuntimeError as e:
        return JSONResponse({"error": str(e)}, status_code=503)
    return {"latency_ms": round((time.perf_counter() - t) * 1000, 1), "model": laya.model_id,
            "device": laya.device, **result}


@app.get("/api/status")
def status():
    return {"laya": {"status": laya.status, "model": laya.model_id, "device": laya.device, "error": laya.error,
                     "question": LAYA_QUESTION["green"], "prewarm": laya.prewarm,
                     "model_ms_per_sentence": laya.model_ms_per_sentence},
            "llm": {"ready": llm.ready, "provider": llm.settings.get("provider"), "model": llm.settings.get("model"),
                    "error": llm.last_error}}


@app.post("/api/decide")
async def decide(req: DecideRequest):
    states = [s.model_dump() for s in req.intersections]
    brain = laya if req.brain == "laya" else llm
    decisions, ms, source = await brain.decide(states)
    body: Dict[str, Any] = {"source": source, "latency_ms": round(ms, 1), "decisions": decisions}
    if brain is laya and source == "laya":
        body["stats"] = laya.last_stats
    if source == "llm-error":
        body["error"] = llm.last_error
    return body


@app.post("/api/llm/settings")
def llm_settings(s: LLMSettings):
    llm.configure(s.model_dump())
    llm.last_error = None
    return {"ok": True, "ready": llm.ready}


@app.post("/api/llm/test")
async def llm_test():
    if not llm.ready:
        return JSONResponse({"ok": False, "error": "LLM تنظیم نشده است."}, status_code=400)
    s = {"id": "T1", "queues": {"N": 12, "S": 8, "E": 2, "W": 1}}
    d, ms, src = await llm.decide([s])
    return {"ok": src == "llm" and "T1" in d, "latency_ms": round(ms, 1), "source": src,
            "decision": d.get("T1"), "error": llm.last_error if src == "llm-error" else None}


def benchmark_cases(n: int = 24, seed: int = 2026) -> List[Dict[str, Any]]:
    rng = random.Random(seed)
    cases = []
    for k in range(n):
        s = {"id": f"X{k}",
             "queues": {d: rng.randint(0, 12) for d in DIRS},
             "approaching": {d: rng.randint(0, 5) for d in DIRS},
             "wait": {d: rng.uniform(0, 60) for d in DIRS},
             "downstream": {d: rng.uniform(0.1, 0.95) for d in DIRS},
             "green_axis": rng.choice(["ns", "ew"])}
        if k % 6 == 3:
            s["emergency_dir"] = rng.choice(DIRS)
        cases.append(s)
    return cases


@app.post("/api/benchmark")
async def benchmark():
    cases = benchmark_cases()
    ref = {s["id"]: reference_axis(s) for s in cases}
    out: Dict[str, Any] = {"cases": len(cases),
                           "note": "Reference = قاعده‌ی شفاف فشار صف + اولویت امدادی؛ دقت ایمنی واقعی نیست."}
    picks: Dict[str, Dict[str, Any]] = {}
    for name, brain in (("laya", laya), ("llm", llm)):
        if name == "llm" and not llm.ready:
            out[name] = None
            continue
        d, ms, src = await brain.decide(cases)
        picks[name] = d
        ok = sum(1 for s in cases if d.get(s["id"], {}).get("axis") == ref[s["id"]])
        em = [s for s in cases if s.get("emergency_dir")]
        em_ok = sum(1 for s in em if d.get(s["id"], {}).get("axis") == ref[s["id"]])
        out[name] = {"source": src, "latency_ms": round(ms, 1), "per_case_ms": (laya.model_ms_per_sentence if brain is laya and laya.model_ms_per_sentence
                                         else round(ms / len(cases), 1)),
                     "alignment": round(100 * ok / len(cases), 1), "emergency": f"{em_ok}/{len(em)}"}
    out["samples"] = [{"id": s["id"], "text": state_text(s), "reference": ref[s["id"]],
                       **{k: v.get(s["id"], {}).get("axis") for k, v in picks.items()}} for s in cases[:8]]
    return out
