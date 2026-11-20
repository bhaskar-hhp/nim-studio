#!/usr/bin/env python3
"""Refresh docs/models-snapshot.json from the live NIM catalogue.

    NVIDIA_API_KEY=nvapi-... python3 scripts/fetch_models.py

The snapshot is the offline fallback the UI uses when the Worker is
unreachable or not configured yet.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

URL = "https://integrate.api.nvidia.com/v1/models"
OUT = Path(__file__).resolve().parent.parent / "docs" / "models-snapshot.json"


def main() -> int:
    key = os.environ.get("NVIDIA_API_KEY", "").strip()
    if not key:
        print("NVIDIA_API_KEY is not set", file=sys.stderr)
        return 1

    req = urllib.request.Request(URL, headers={
        "Authorization": f"Bearer {key}",
        "Accept": "application/json",
    })
    with urllib.request.urlopen(req, timeout=60) as res:
        payload = json.load(res)

    models = [
        {
            "id": str(m.get("id", "")),
            "owned_by": str(m.get("owned_by", "")),
            "created": m.get("created", 0),
        }
        for m in payload.get("data", payload.get("models", []))
        if m.get("id")
    ]

    body = {
        "ok": True,
        "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "snapshot",
        "models": models,
    }
    OUT.write_text(json.dumps(body, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {OUT} ({len(models)} models)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
