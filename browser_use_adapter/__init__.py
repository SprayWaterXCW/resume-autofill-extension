"""Isolated, local-only Browser Use pilot for fictional resume data."""

import os
from pathlib import Path

# Set these before importing browser_use. The upstream library otherwise creates
# user-level config directories and enables telemetry by default.
os.environ["ANONYMIZED_TELEMETRY"] = "false"
os.environ["BROWSER_USE_CLOUD_SYNC"] = "false"
os.environ["BROWSER_USE_CONFIG_DIR"] = str(Path(__file__).resolve().parents[1] / ".browser-use-runtime")
