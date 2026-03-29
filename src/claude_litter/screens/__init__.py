"""Screens for Litter TUI."""

from .broadcast_message import BroadcastMessageScreen
from .configure_agent import ConfigureAgentScreen
from .confirm import ConfirmScreen
from .create_team import CreateTeamScreen
from .duplicate_agent import DuplicateAgentScreen
from .main import MainScreen
from .rename_team import RenameTeamScreen
from .settings import SettingsScreen
from .spawn_agent import SpawnAgentScreen
from .task_detail import TaskDetailScreen

__all__ = [
    "MainScreen",
    "CreateTeamScreen",
    "SpawnAgentScreen",
    "TaskDetailScreen",
    "SettingsScreen",
    "DuplicateAgentScreen",
    "ConfigureAgentScreen",
    "ConfirmScreen",
    "RenameTeamScreen",
    "BroadcastMessageScreen",
]
