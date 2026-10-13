import unittest
from solution import chunks


class ChunkTests(unittest.TestCase):
    def test_empty(self):
        self.assertEqual(chunks([], 3), [])

    def test_singleton(self):
        self.assertEqual(chunks(["only"], 4), [["only"]])

    def test_unit_size(self):
        self.assertEqual(chunks([3, 1, 4], 1), [[3], [1], [4]])

    def test_exact_boundary(self):
        self.assertEqual(chunks([1, 2, 3, 4], 2), [[1, 2], [3, 4]])

    def test_one_element_remainder(self):
        self.assertEqual(chunks([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])

    def test_larger_remainder(self):
        self.assertEqual(chunks([1, 2, 3, 4, 5], 3), [[1, 2, 3], [4, 5]])

    def test_oversize_and_independence(self):
        source = [1, 2]
        result = chunks(source, 9)
        self.assertEqual(result, [[1, 2]])
        self.assertIsNot(result[0], source)
        result[0].append(3)
        self.assertEqual(source, [1, 2])

    def test_invalid_sizes_even_for_empty_input(self):
        for size in (0, -1, True, False, 2.0, "2", None):
            for values in ([], [1, 2]):
                with self.subTest(size=size, values=values):
                    with self.assertRaises(ValueError):
                        chunks(values, size)
