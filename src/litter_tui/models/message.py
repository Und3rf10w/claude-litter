from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Self


@dataclass(frozen=True)
class Message:
    from_agent: str
    text: str
    timestamp: str
    read: bool
    color: str | None = None
    summary: str | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Self:
        return cls(
            from_agent=data["from"],
            text=data["text"],
            timestamp=data.get("timestamp", ""),
            read=data.get("read", False),
            color=data.get("color"),
            summary=data.get("summary"),
        )

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "from": self.from_agent,
            "text": self.text,
            "timestamp": self.timestamp,
            "read": self.read,
        }
        if self.color is not None:
            d["color"] = self.color
        if self.summary is not None:
            d["summary"] = self.summary
        return d
