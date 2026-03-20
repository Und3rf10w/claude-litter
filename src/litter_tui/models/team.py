"""Team data models."""
from __future__ import annotations
from dataclasses import dataclass, field


@dataclass(frozen=True)
class TeamMember:
    name: str
    agent_type: str = "worker"
    agent_id: str = ""
    status: str = "unknown"


@dataclass(frozen=True)
class Team:
    name: str
    members: tuple["TeamMember", ...] = field(default_factory=tuple)
    lead: str = ""
