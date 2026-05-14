import subprocess
import sys
import time
import os

processes = []

# Always resolve paths relative to this script's location
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Use module notation instead of file paths
modules = [
    "server",                      # server.py
]

try:
    for module in modules:
        print(f"Starting {module}...")
        p = subprocess.Popen(
            [sys.executable, "-m", module],
            cwd=BASE_DIR  # Run from project root so imports resolve correctly
        )
        processes.append(p)

    print("All services started.")

    while True:
        time.sleep(1)

except KeyboardInterrupt:
    print("\nStopping all processes...")
    for p in processes:
        p.terminate()
    print("All processes stopped.")