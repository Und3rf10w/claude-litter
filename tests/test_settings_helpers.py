from __future__ import annotations

from claude_litter.screens.settings import _mask_token, _resolve_theme


class TestResolveTheme:
    def test_alias_dark(self):
        assert _resolve_theme("dark") == "textual-dark"

    def test_alias_light(self):
        assert _resolve_theme("light") == "textual-light"

    def test_unknown_name_passthrough(self):
        assert _resolve_theme("gruvbox") == "gruvbox"

    def test_empty_string_passthrough(self):
        assert _resolve_theme("") == ""

    def test_valid_textual_name_passthrough(self):
        assert _resolve_theme("textual-dark") == "textual-dark"


class TestMaskToken:
    def test_none_returns_not_set(self):
        assert _mask_token(None) == "(not set)"

    def test_empty_string_returns_not_set(self):
        assert _mask_token("") == "(not set)"

    def test_short_token_3_chars(self):
        assert _mask_token("abc") == "****"

    def test_exactly_8_chars(self):
        assert _mask_token("abcdefgh") == "****"

    def test_9_chars_first4_last4(self):
        token = "abcdefghi"
        assert _mask_token(token) == "abcd...fghi"

    def test_12_chars_first4_last4(self):
        token = "abcdefghijkl"
        assert _mask_token(token) == "abcd...ijkl"

    def test_exactly_16_chars_first4_last4(self):
        token = "abcdefghijklmnop"
        assert _mask_token(token) == "abcd...mnop"

    def test_17_chars_first8_last4(self):
        token = "abcdefghijklmnopq"
        assert _mask_token(token) == "abcdefgh...nopq"

    def test_32_chars_first8_last4(self):
        token = "a" * 32
        assert _mask_token(token) == "aaaaaaaa...aaaa"
