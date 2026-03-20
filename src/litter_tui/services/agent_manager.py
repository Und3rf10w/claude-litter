"""AgentManager stub."""
from __future__ import annotations
from dataclasses import dataclass


@dataclass
class AgentSession:
    team_name: str
    agent_name: str
    model: str = "sonnet"


class AgentManager:
    """Stub agent manager."""
    pass
