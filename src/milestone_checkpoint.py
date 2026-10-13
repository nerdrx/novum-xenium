"""Bounded first-checkpoint gate for automatic coding milestones."""


class MilestoneCheckpoint:
    """Require one useful todo checkpoint; caller stops after two rejected rounds."""

    directive = (
        "Before implementation, call todowrite now with 3-7 concrete milestones. "
        "Include a completion check in each item. Mark exactly one in_progress and "
        "the remaining work pending. Then implement and verify that first slice. "
        "A prose plan does not save progress. This checkpoint grants no permissions "
        "and needs no separate plan-approval question."
    )

    def __init__(self, enabled: bool, restored_todos=None):
        self.enabled = bool(enabled)
        self._rejections = 0
        self._accepted = self._valid_todos(restored_todos, allow_completed=True)

    @staticmethod
    def _valid_todos(todos, *, allow_completed=False):
        if not isinstance(todos, list) or len(todos) < 2:
            return False
        statuses = []
        for item in todos:
            if not isinstance(item, dict):
                return False
            content = item.get("content")
            status = item.get("status")
            if not isinstance(content, str) or not content.strip():
                return False
            if not isinstance(status, str) or status not in {"pending", "in_progress", "completed"}:
                return False
            statuses.append(status)
        if allow_completed and (all(status == "completed" for status in statuses)
                                or statuses.count("in_progress") == 1):
            return True
        return statuses.count("in_progress") == 1 and "pending" in statuses

    @property
    def pending(self):
        return self.enabled and not self._accepted

    def restore(self, todos) -> bool:
        """Resume persisted progress, including the last remaining milestone."""
        if self.pending and self._valid_todos(todos, allow_completed=True):
            self._accepted = True
            return True
        return False

    def observe(self, tool, result) -> bool:
        """Accept only a successful todowrite with actionable remaining work."""
        if not self.pending or tool != "todowrite" or not isinstance(result, dict):
            return False
        if (type(result.get("exit_code")) is not int or result.get("exit_code") != 0 or result.get("error")
                or result.get("approval_required")):
            return False
        if not self._valid_todos(result.get("todos")):
            return False
        self._accepted = True
        return True

    def reject(self) -> bool:
        """Record a rejected round; return true once the two-round cap is met."""
        if not self.pending:
            return self._rejections >= 2
        self._rejections += 1
        return self._rejections >= 2
