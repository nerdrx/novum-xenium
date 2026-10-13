import unittest
from progress import parse_progress


def record(time_seconds=None, speed=None, frame=None, done=False):
    return dict(time_seconds=time_seconds, speed=speed, frame=frame, done=done)


class ProgressTests(unittest.TestCase):
    def test_typical_generator_and_independent_records(self):
        lines = iter(['frame=12\n', 'out_time_us=1250000\n', 'speed=1.5x\n',
                      'progress=continue\n', 'frame=24', 'out_time_us=2500000',
                      'progress=end'])
        self.assertEqual(parse_progress(lines),
                         [record(1.25, 1.5, 12), record(2.5, None, 24, True)])

    def test_empty_missing_and_unterminated(self):
        self.assertEqual(parse_progress([]), [])
        self.assertEqual(parse_progress(['frame=1']), [])
        self.assertEqual(parse_progress(['progress=continue', 'progress=end', 'frame=7']),
                         [record(), record(done=True)])

    def test_whitespace_unknown_and_first_equals(self):
        self.assertEqual(parse_progress([' ', 'noise', 'unknown=4', ' speed = 2x ',
                                         'frame=3=4', 'out_time_us = 500000 ',
                                         'progress=unknown', ' progress = end ']),
                         [record(0.5, 2.0, None, True)])

    def test_zero_and_explicit_plus(self):
        actual = parse_progress(['frame=+0', 'out_time_us=+0', 'speed=0x', 'progress=end'])
        self.assertEqual(actual, [record(0.0, 0.0, 0, True)])
        self.assertIs(type(actual[0]['time_seconds']), float)
        self.assertIs(type(actual[0]['speed']), float)
        self.assertIs(type(actual[0]['frame']), int)
        self.assertIs(type(actual[0]['done']), bool)

    def test_bad_integer_fields(self):
        for value in ('N/A', '', '-1', '1.5', '1e3', 'nan', 'inf', 'word', '++2'):
            with self.subTest(value=value):
                self.assertEqual(parse_progress([f'frame={value}', f'out_time_us={value}',
                                                 'progress=continue']), [record()])

    def test_bad_speed_fields(self):
        for value in ('N/A', '', '-1x', 'nanx', 'infx', '-infx', '1e999x', '2', 'x', '2xx', '1=2x'):
            with self.subTest(value=value):
                self.assertEqual(parse_progress([f'speed={value}', 'progress=end']),
                                 [record(done=True)])

    def test_large_time_overflow_is_invalid(self):
        self.assertEqual(parse_progress(['out_time_us=' + '9' * 400, 'progress=end']),
                         [record(done=True)])

    def test_repeated_fields_last_value_wins(self):
        self.assertEqual(parse_progress(['frame=2', 'frame=7', 'speed=1x', 'speed=N/A',
                                         'out_time_us=1000000', 'out_time_us=2000000',
                                         'progress=continue']), [record(2.0, None, 7)])

    def test_invalid_value_replaces_valid_without_carryover(self):
        self.assertEqual(parse_progress(['frame=2', 'frame=N/A', 'out_time_us=1',
                                         'out_time_us=-2', 'progress=continue',
                                         'speed=3x', 'progress=end', 'progress=continue']),
                         [record(), record(speed=3.0, done=True), record()])

    def test_results_are_separate_dictionaries(self):
        actual = parse_progress(['frame=1', 'progress=continue', 'frame=2', 'progress=end'])
        self.assertEqual(actual, [record(frame=1), record(frame=2, done=True)])
        self.assertIsNot(actual[0], actual[1])


if __name__ == '__main__':
    unittest.main()
