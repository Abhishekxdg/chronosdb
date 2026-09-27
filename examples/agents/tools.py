"""Run the tools in tools.json against `chronos serve`: hand tools.json to any LLM API that supports
tool calling, and pass each tool call it makes to `run_tool`. Replies are JSON text for the model.

    import json, tools
    definitions = json.load(open("tools.json"))
    ...your agent loop: for each tool call → result = tools.run_tool(db, call.name, call.input)

Self-check against a running server:  CHRONOS_URL=http://127.0.0.1:7070 python3 tools.py
"""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "clients", "python"))
from chronos import Chronos, ChronosError  # noqa: E402

# One client per branch, so each remembers its last write's version and merges safely.
_branches: dict = {}


def _on(db: Chronos, args: dict) -> Chronos:
    name = args.get("branch") or "main"
    if name not in _branches:
        _branches[name] = db.branch(name)
    return _branches[name]


def run_tool(db: Chronos, name: str, args: dict) -> str:
    """Runs one tool call; errors come back as text the model can act on, not exceptions."""
    try:
        if name == "chronos_fork":
            _branches[args["name"]] = db.fork(args["name"])
            return json.dumps({"ok": True, "branch": args["name"]})
        b = _on(db, args)
        if name == "chronos_find":
            return json.dumps(b.find(args["table"], where=args.get("where"), text=args.get("text"),
                                     limit=args.get("limit"), offset=args.get("offset")))
        if name == "chronos_get":
            return json.dumps({"row": b.get(args["table"], args["id"])})
        if name == "chronos_put":
            b.put(args["table"], args["id"], args["record"])
            return json.dumps({"ok": True})
        if name == "chronos_delete":
            b.delete(args["table"], args["id"])
            return json.dumps({"ok": True})
        if name == "chronos_diff":
            return json.dumps({"changes": b.diff()})
        if name == "chronos_merge":
            merged = b.merge(args.get("resolve", "fail"))
            _branches.pop(b.branch_name, None)
            return json.dumps({"merged": merged})
        if name == "chronos_discard":
            b.discard()
            _branches.pop(b.branch_name, None)
            return json.dumps({"ok": True})
        return json.dumps({"error": f"unknown tool {name}"})
    except ChronosError as e:
        return json.dumps({"error": str(e), "status": e.status, "conflicts": e.conflicts})


if __name__ == "__main__":
    db = Chronos(os.environ["CHRONOS_URL"], token=os.environ.get("CHRONOS_TOKEN"))
    names = {t["name"] for t in json.load(open(os.path.join(os.path.dirname(__file__), "tools.json")))}
    calls = [
        ("chronos_fork", {"name": "demo-agent"}),
        ("chronos_put", {"branch": "demo-agent", "table": "tasks", "id": "1", "record": {"title": "Write docs", "done": True}}),
        ("chronos_diff", {"branch": "demo-agent"}),
        ("chronos_merge", {"branch": "demo-agent"}),
        ("chronos_find", {"table": "tasks", "text": "docs"}),
    ]
    for name, args in calls:
        assert name in names, name
        out = json.loads(run_tool(db, name, args))
        assert "error" not in out, out
        print(name, "->", out)
    print("tools: ok")
