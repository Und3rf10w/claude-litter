"""Test that all package imports succeed."""
import importlib


def test_package_import():
    import claude_litter
    assert claude_litter.__version__ == "0.1.0"


def test_app_import():
    from claude_litter.app import ClaudeLitterApp
    assert ClaudeLitterApp is not None


def test_config_import():
    from claude_litter.config import Config
    cfg = Config()
    assert cfg.vim_mode is False
    assert cfg.theme == "dark"


def test_models_import():
    from claude_litter.models import Team, TeamMember, Task, TaskStatus, Message
    assert Team is not None
    assert TeamMember is not None
    assert Task is not None
    assert TaskStatus is not None
    assert Message is not None


def test_services_import():
    from claude_litter.services import StateManager, AgentManager, AgentSession, TeamService, KittyService
    assert StateManager is not None
    assert AgentManager is not None
    assert AgentSession is not None
    assert TeamService is not None
    assert KittyService is not None


def test_widgets_import():
    from claude_litter.widgets import TeamSidebar, SessionTabBar, StatusBar
    from claude_litter.widgets import TaskPanel, MessagePanel, SessionView, InputBar
    assert TeamSidebar is not None
    assert SessionTabBar is not None
    assert StatusBar is not None
    assert TaskPanel is not None
    assert MessagePanel is not None
    assert SessionView is not None
    assert InputBar is not None


def test_screens_import():
    from claude_litter.screens.main import MainScreen
    from claude_litter.screens import CreateTeamScreen, SpawnAgentScreen
    from claude_litter.screens import TaskDetailScreen, SettingsScreen
    assert MainScreen is not None
    assert CreateTeamScreen is not None
    assert SpawnAgentScreen is not None
    assert TaskDetailScreen is not None
    assert SettingsScreen is not None
