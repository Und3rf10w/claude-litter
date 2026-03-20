"""Team data model."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Self


@dataclass(frozen=True)
class TeamMember:
    agentId: str
    name: str
    agentType: str
    model: str
    joinedAt: int
    tmuxPaneId: str
    cwd: str
    subscriptions: tuple[str, ...]
    prompt: str | None = None
    color: str | None = None
    planModeRequired: bool | None = None
    backendType: str | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Self:
        return cls(
            agentId=data["agentId"],
            name=data["name"],
            agentType=data["agentType"],
            model=data["model"],
            joinedAt=data["joinedAt"],
            tmuxPaneId=data.get("tmuxPaneId", ""),
            cwd=data.get("cwd", ""),
            subscriptions=tuple(data.get("subscriptions", [])),
            prompt=data.get("prompt"),
            color=data.get("color"),
            planModeRequired=data.get("planModeRequired"),
            backendType=data.get("backendType"),
        )

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "agentId": self.agentId,
            "name": self.name,
            "agentType": self.agentType,
            "model": self.model,
            "joinedAt": self.joinedAt,
            "tmuxPaneId": self.tmuxPaneId,
            "cwd": self.cwd,
            "subscriptions": list(self.subscriptions),
        }
        if self.prompt is not None:
            d["prompt"] = self.prompt
        if self.color is not None:
            d["color"] = self.color
        if self.planModeRequired is not None:
            d["planModeRequired"] = self.planModeRequired
        if self.backendType is not None:
            d["backendType"] = self.backendType
        return d


@dataclass(frozen=True)
class Team:
    name: str
    description: str
    createdAt: int
    leadAgentId: str
    leadSessionId: str
    members: tuple[TeamMember, ...]

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Self:
        return cls(
            name=data["name"],
            description=data.get("description", ""),
            createdAt=data["createdAt"],
            leadAgentId=data["leadAgentId"],
            leadSessionId=data.get("leadSessionId", ""),
            members=tuple(TeamMember.from_dict(m) for m in data.get("members", [])),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "createdAt": self.createdAt,
            "leadAgentId": self.leadAgentId,
            "leadSessionId": self.leadSessionId,
            "members": [m.to_dict() for m in self.members],
        }
