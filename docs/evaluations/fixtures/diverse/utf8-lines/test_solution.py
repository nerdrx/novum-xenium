import unittest

from solution import decode_lines


class DecodeLinesTests(unittest.TestCase):
    def test_empty_input_and_chunks(self):
        self.assertEqual(decode_lines([]), [])
        self.assertEqual(decode_lines([b'', b'', b'']), [])

    def test_unicode_at_every_byte_boundary(self):
        text = 'café\n猫 🐾\n終'
        encoded = text.encode('utf-8')
        expected = ['café', '猫 🐾', '終']
        self.assertEqual(decode_lines([bytes([byte]) for byte in encoded]), expected)
        for split in range(len(encoded) + 1):
            with self.subTest(split=split):
                self.assertEqual(decode_lines([encoded[:split], b'', encoded[split:]]), expected)

    def test_crlf_split_between_chunks(self):
        self.assertEqual(decode_lines([b'first\r', b'', b'\nsecond\r', b'\n']), ['first', 'second'])

    def test_lone_cr_and_whitespace_preserved(self):
        self.assertEqual(decode_lines([b' a\rb \t\n\r\r\nend\r']), [' a\rb \t', '\r', 'end\r'])

    def test_empty_lines_without_spurious_trailing_line(self):
        for source, expected in [(b'\n', ['']), (b'a\n', ['a']), (b'a\n\n', ['a', '']),
                                 (b'\r\n\r\n', ['', '']), (b'\n\n\n', ['', '', ''])]:
            with self.subTest(source=source):
                self.assertEqual(decode_lines([source]), expected)

    def test_final_unterminated_line(self):
        self.assertEqual(decode_lines([b'alpha\nbe', b'ta', b'']), ['alpha', 'beta'])
        self.assertEqual(decode_lines([b'only']), ['only'])

    def test_one_shot_generator_returns_list(self):
        chunks = (chunk for chunk in [b'', b'A\nB', b'\r', b'\nC'])
        result = decode_lines(chunks)
        self.assertIsInstance(result, list)
        self.assertEqual(result, ['A', 'B', 'C'])
        self.assertEqual(list(chunks), [])

    def test_invalid_utf8_is_strict_including_final_incomplete_sequence(self):
        cases = [[b'good\n', b'\xff'], [b'\xe2', b'('], [b'\xf0\x9f', b''],
                 [b'\xc0\xaf'], [b'\xed\xa0\x80'], [b'\x80']]
        for chunks in cases:
            with self.subTest(chunks=chunks):
                with self.assertRaises(UnicodeDecodeError):
                    decode_lines(chunks)


if __name__ == '__main__':
    unittest.main()
