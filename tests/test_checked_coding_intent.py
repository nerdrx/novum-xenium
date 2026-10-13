import pytest

from src.checked_coding_intent import _use_checked_coding_workflow


@pytest.mark.parametrize('text', [
    'Implement decode_lines(chunks) using the standard library.',
    'Implement the function decode_lines(chunks).',
    'Fix main.py.',
    'Fix the button layout.',
    'Can you repair the app?',
    'Build a small CLI.',
    'Create a Python script.',
    'Refactor the parser module.',
    'Add tests for the function.',
    "Don't rewrite everything, fix main.py.",
    'Do not edit unrelated files; implement the function.',
    'Never change the app but fix helper.ts.',
    'Review the code and fix the bug.',
])
def test_coding_changes_are_checked(text):
    assert _use_checked_coding_workflow(text, '/workspace')


@pytest.mark.parametrize('text', [
    'Hello!',
    'Write a summary of the code.',
    'What is Rust?',
    'Explain this function.',
    'Read main.py.',
    'Review the code for bugs.',
    'Inspect the repository and report findings.',
    'Run the tests.',
    'Convert this video with ffmpeg.',
    'Create a movie from these clips.',
    'Write a summary of the project.',
    'Open https://example.com/fix/app.',
    "Don't edit main.py.",
    'Never change this function.',
    'How would you fix main.py?',
    'Explain how to implement this function.',
])
def test_ordinary_read_only_and_media_requests_are_not_checked(text):
    assert not _use_checked_coding_workflow(text, '/workspace')


def test_workspace_is_required():
    assert not _use_checked_coding_workflow('Build an app.', None)
    assert not _use_checked_coding_workflow('Fix main.py.', '')
