"""Message data model."""
from __future__ import annotations
from dataclasses import dataclass


@dataclass(frozen=True)
class Message:
    id: str
    sender: str
    content: str
    timestamp: str = ""
    read: bool = False
