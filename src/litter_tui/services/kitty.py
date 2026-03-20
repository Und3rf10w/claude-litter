"""KittyService — kitty terminal integration for swarm window management."""
from __future__ import annotations

import json
import os
from pathlib import Path


class KittyService:
    def detect_kitty(self) -> bool:
        """Return True if running inside a kitty terminal."""
        return os.environ.get("TERM_PROGRAM") == "kitty"

    def find_socket(self) -> Path | None:
        """Find the kitty remote control socket."""
        # Explicit override from env
        env_socket = os.environ.get("KITTY_LISTEN_ON")
        if env_socket:
            # Value may be "unix:/path" or just "/path"
            socket_str = env_socket.removeprefix("unix:")
            return Path(socket_str)

        # Default path: /tmp/kitty-$USER
        user = os.environ.get("USER") or os.environ.get("LOGNAME", "")
        if user:
            candidate = Path(f"/tmp/kitty-{user}")
            if candidate.exists():
                return candidate

        return None

    def validate_socket(self, socket_path: Path) -> bool:
        """Return True if the socket path exists and is a socket."""
        return socket_path.exists() and socket_path.is_socket()

    async def kitten_cmd(self, *args: str) -> str:
        """Run a kitten @ command and return stdout."""
        if not self.detect_kitty():
            return ""

        socket = self.find_socket()
        cmd = ["kitten", "@"]
        if socket:
            cmd += ["--to", f"unix:{socket}"]
        cmd += list(args)

        try:
            import anyio
            result = await anyio.run_process(cmd, check=True)
            return result.stdout.decode() if result.stdout else ""
        except Exception:
            return ""

    async def pop_out_agent(
        self,
        team: str,
        agent: str,
        mode: str = "split",
    ) -> None:
        """Open an agent window in kitty (split / tab / os-window)."""
        if not self.detect_kitty():
            return

        mode_map = {
            "split": ["launch", "--location=vsplit"],
            "tab": ["launch", "--type=tab"],
            "window": ["launch", "--type=os-window"],
            "os-window": ["launch", "--type=os-window"],
        }
        base_args = mode_map.get(mode, mode_map["split"])

        await self.kitten_cmd(
            *base_args,
            "--var", f"swarm_{team}_{agent}=true",
            "--title", f"[swarm] {team}/{agent}",
        )

    async def list_windows(self) -> list[dict]:
        """Return kitty window list as parsed JSON."""
        if not self.detect_kitty():
            return []
        raw = await self.kitten_cmd("ls")
        if not raw:
            return []
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return []

    async def focus_window(self, match: str) -> None:
        """Focus a kitty window by match expression."""
        if not self.detect_kitty():
            return
        await self.kitten_cmd("focus-window", "--match", match)

    async def close_window(self, match: str) -> None:
        """Close a kitty window by match expression."""
        if not self.detect_kitty():
            return
        await self.kitten_cmd("close-window", "--match", match)

    async def send_text(self, match: str, text: str) -> None:
        """Send text to a kitty window by match expression."""
        if not self.detect_kitty():
            return
        await self.kitten_cmd("send-text", "--match", match, text)
