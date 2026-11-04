# phonedock (Python)

Stdlib-only client for the PhoneDock daemon. See `docs/AGENTS-GUIDE.md` and `docs/API.md` in the repo.

```python
from phonedock import PhoneDock
pd = PhoneDock()                      # discovers $PHONEDOCK_HOME/daemon.json, starts the daemon if needed
dev = pd.acquire(platform="android")["device"]
print(pd.ui_text(dev["id"]))
pd.tap(dev["id"], 540, 1200)
open("shot.png", "wb").write(pd.screenshot(dev["id"])["data"])
pd.release(dev["id"])
```
