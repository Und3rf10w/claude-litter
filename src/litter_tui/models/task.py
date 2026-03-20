"""Task data models."""
from __future__ import annotations
from dataclasses import dataclass
from enum import Enum


class TaskStatus(Enum):
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"


@dataclass(frozen=True)
class Task:
    id: str
    subject: str
    description: str = ""
    owner: str = ""
