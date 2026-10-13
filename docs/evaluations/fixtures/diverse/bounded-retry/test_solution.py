import unittest
from solution import retry_call


class RetryTests(unittest.TestCase):
    def test_first_success_preserves_identity(self):
        value = object()
        calls = []
        self.assertIs(retry_call(lambda: (calls.append(1), value)[1], 4, (ValueError,)), value)
        self.assertEqual(calls, [1])

    def test_falsey_success_is_not_retried(self):
        for value in (None, False, 0, ""):
            calls = []
            with self.subTest(value=value):
                self.assertIs(retry_call(lambda: (calls.append(1), value)[1], 3, (Exception,)), value)
                self.assertEqual(len(calls), 1)

    def test_retries_matching_subclasses_then_succeeds(self):
        class Temporary(ValueError):
            pass
        outcomes = iter([Temporary("first"), TypeError("second"), 42])
        calls = []
        def operation():
            calls.append(1)
            outcome = next(outcomes)
            if isinstance(outcome, Exception):
                raise outcome
            return outcome
        self.assertEqual(retry_call(operation, 3, (ValueError, TypeError)), 42)
        self.assertEqual(len(calls), 3)

    def test_exhaustion_propagates_last_exact_exception(self):
        errors = [ValueError("first"), ValueError("last")]
        calls = []
        def operation():
            index = len(calls)
            calls.append(1)
            raise errors[index]
        with self.assertRaises(ValueError) as caught:
            retry_call(operation, 2, (ValueError,))
        self.assertIs(caught.exception, errors[1])
        self.assertEqual(len(calls), 2)

    def test_one_attempt_means_one_call(self):
        error = ValueError("only")
        calls = []
        def operation():
            calls.append(1)
            raise error
        with self.assertRaises(ValueError) as caught:
            retry_call(operation, 1, (ValueError,))
        self.assertIs(caught.exception, error)
        self.assertEqual(len(calls), 1)

    def test_nonmatching_and_empty_tuple_propagate_immediately(self):
        for retry_on in ((ValueError,), ()):
            error = TypeError("do not retry")
            calls = []
            def operation():
                calls.append(1)
                raise error
            with self.subTest(retry_on=retry_on), self.assertRaises(TypeError) as caught:
                retry_call(operation, 5, retry_on)
            self.assertIs(caught.exception, error)
            self.assertEqual(len(calls), 1)

    def test_invalid_attempts_have_no_side_effects(self):
        for attempts in (0, -1, True, False, 2.0, "2", None):
            calls = []
            with self.subTest(attempts=attempts), self.assertRaises(ValueError):
                retry_call(lambda: calls.append(1), attempts, (Exception,))
            self.assertEqual(calls, [])

    def test_keyboard_interrupt_propagates(self):
        error = KeyboardInterrupt()
        calls = []
        def operation():
            calls.append(1)
            raise error
        with self.assertRaises(KeyboardInterrupt) as caught:
            retry_call(operation, 3, (Exception,))
        self.assertIs(caught.exception, error)
        self.assertEqual(len(calls), 1)

    def test_calls_have_independent_budgets(self):
        counts = []
        for _ in range(2):
            calls = []
            def operation():
                calls.append(1)
                if len(calls) == 1:
                    raise ValueError("retry")
                return "ok"
            self.assertEqual(retry_call(operation, 2, (ValueError,)), "ok")
            counts.append(len(calls))
        self.assertEqual(counts, [2, 2])
