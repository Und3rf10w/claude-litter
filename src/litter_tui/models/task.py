from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Self


class TaskStatus(str, Enum):
    pending = "pending"
    in_progress = "in_progress"
    completed = "completed"


@dataclass(frozen=True)
class Task:
    id: str
    subject: str
    description: str
    status: TaskStatus
    blocks: tuple[str, ...] = ()
    blockedBy: tuple[str, ...] = ()
    owner: str | None = None
    activeForm: str | None = None
    # metadata is intentionally not frozen — dict cannot be hashed
    metadata: dict[str, Any] | None = field(default=None, hash=False, compare=False)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Self:
        raw_status = data.get("status", "pending")
        try:
            status = TaskStatus(raw_status)
        except ValueError:
            status = TaskStatus.pending

        return cls(
            id=data["id"],
            subject=data["subject"],
            description=data.get("description", ""),
            status=status,
            blocks=tuple(data.get("blocks", [])),
            blockedBy=tuple(data.get("blockedBy", [])),
            owner=data.get("owner"),
            activeForm=data.get("activeForm"),
            metadata=data.get("metadata"),
        )

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "id": self.id,
            "subject": self.subject,
            "description": self.description,
            "status": self.status.value,
            "blocks": list(self.blocks),
            "blockedBy": list(self.blockedBy),
        }
        if self.owner is not None:
            d["owner"] = self.owner
        if self.activeForm is not None:
            d["activeForm"] = self.activeForm
        if self.metadata is not None:
            d["metadata"] = self.metadata
        return d
