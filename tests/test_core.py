import os

os.environ["LAYA_PRELOAD"] = "0"

from fastapi.testclient import TestClient  # noqa: E402

from app import main  # noqa: E402
from app.brains import (LAYA_QUESTION, axis_pressure, band, parse_json_object,  # noqa: E402
                        reference_axis, state_text)


def sensors(**kw):
    s = {"id": "A1", "queues": {"N": 0, "S": 0, "E": 0, "W": 0}, "approaching": {}, "wait": {}, "downstream": {},
         "emergency_dir": None, "blocked_dir": None, "green_axis": "ns"}
    s.update(kw)
    return s


def no_model():
    """Force the transparent fallback so tests never download the checkpoint."""
    main.laya.status = "error"
    main.laya.agent = None


def test_state_text_is_short_and_qualitative():
    s = sensors(queues={"N": 9, "S": 7, "E": 1, "W": 0})
    t = state_text(s)
    assert t == ("North-south traffic is severely jammed. East-west traffic is light. "
                 "More cars are waiting on the north-south road.")
    assert len(t.split()) < 40  # far below Laya's 512-token context


def test_comparison_sentence():
    t = state_text(sensors(queues={"N": 3, "S": 3, "E": 2, "W": 3}))
    assert "More cars are waiting on the north-south road." in t
    assert state_text(sensors()).endswith("Both roads are equally busy.")


def test_emergency_sentence_and_reference_priority():
    s = sensors(queues={"N": 0, "S": 0, "E": 10, "W": 10}, emergency_dir="S")
    assert "An ambulance is coming on the north-south road." in state_text(s)
    assert reference_axis(s) == "ns"


def test_full_exit_road_reduces_pressure():
    free = axis_pressure(sensors(queues={"N": 8, "S": 0, "E": 0, "W": 0}))["ns"]
    full = axis_pressure(sensors(queues={"N": 8, "S": 0, "E": 0, "W": 0}, downstream={"N": 0.97}))["ns"]
    assert full < free * 0.2


def test_blocked_approach_reduces_pressure():
    s = sensors(queues={"N": 10, "S": 0, "E": 4, "W": 0}, blocked_dir="N")
    assert reference_axis(s) == "ew"


def test_band_edges():
    assert [band(x) for x in (0, 1, 5, 10, 20)] == ["empty", "light", "moderate", "heavy", "severely jammed"]


def test_question_is_valid_laya_choice():
    q = LAYA_QUESTION["green"]
    assert q["type"] == "choice" and set(q["criteria"]) == {"ns", "ew"}


def test_parse_json_object_handles_fences():
    assert parse_json_object('```json\n{"decisions": {"A1": "ns"}}\n```')["decisions"]["A1"] == "ns"
    assert parse_json_object('sure: {"a": 1} ok')["a"] == 1


def test_decide_endpoint_fallback_is_labelled():
    no_model()
    c = TestClient(main.app)
    r = c.post("/api/decide", json={"brain": "laya", "intersections": [sensors(queues={"N": 1, "S": 0, "E": 9, "W": 8})]})
    body = r.json()
    assert r.status_code == 200
    assert body["source"] == "reference-fallback"
    d = body["decisions"]["A1"]
    assert d["axis"] == "ew" and d["phase"] == "EW_GREEN"
    assert d["state_text"].startswith("North-south traffic is")


def test_llm_disabled_returns_no_decisions():
    c = TestClient(main.app)
    r = c.post("/api/decide", json={"brain": "llm", "intersections": [sensors()]})
    assert r.json()["source"] == "llm-disabled"
    assert r.json()["decisions"] == {}


def test_status_and_benchmark():
    no_model()
    c = TestClient(main.app)
    st = c.get("/api/status").json()
    assert st["laya"]["question"]["type"] == "choice"
    b = c.post("/api/benchmark").json()
    assert b["cases"] == 24
    assert b["laya"]["alignment"] == 100.0  # fallback == reference by construction
    assert b["llm"] is None


def test_every_live_sentence_is_precomputable():
    import random
    from app.brains import all_texts
    known = set(all_texts())
    rng = random.Random(3)
    for _ in range(3000):
        s = sensors(queues={d: rng.randint(0, 15) for d in "NSEW"}, approaching={d: rng.randint(0, 6) for d in "NSEW"},
                    wait={d: rng.uniform(0, 90) for d in "NSEW"}, downstream={d: rng.uniform(0, 1) for d in "NSEW"},
                    emergency_dir=rng.choice([None, None, "N", "S", "E", "W"]), blocked_dir=rng.choice([None, "N", "E"]))
        assert state_text(s) in known


def test_playground_endpoint_validation_and_no_model():
    no_model()
    c = TestClient(main.app)
    assert c.get("/laya").status_code == 200
    assert c.post("/api/laya/predict", json={"state": "hi", "questions": {}}).status_code == 400
    r = c.post("/api/laya/predict", json={"state": "hi", "questions": {"q": {"type": "noul", "instructions": "Is it a greeting?"}}})
    assert r.status_code == 503  # model not loaded in tests: a clear error, never a fake answer
