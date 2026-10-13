import unittest
from decimal import Decimal
from solution import totals


class TotalsTests(unittest.TestCase):
    def test_empty_and_blank(self):
        self.assertEqual(totals(""), {})
        self.assertEqual(totals("\n\r\n"), {})

    def test_exact_decimal_addition(self):
        actual = totals("Ada,0.1\nAda,0.2\nBob,-2.50\nAda,-0.3\nBob,+3\n")
        self.assertEqual(actual, {"Ada": Decimal("0"), "Bob": Decimal("0.50")})
        self.assertTrue(all(isinstance(value, Decimal) for value in actual.values()))

    def test_csv_quoted_names(self):
        text = '"Doe, Jane",1.25\n"Doe, Jane",2.75\n"A ""quoted"" name",4\n'
        self.assertEqual(totals(text), {"Doe, Jane": Decimal("4.00"), 'A "quoted" name': Decimal("4")})

    def test_multiline_name(self):
        self.assertEqual(totals('"two\nlines",2\n"two\nlines",3'),
                         {"two\nlines": Decimal("5")})

    def test_whitespace_case_and_leading_zeros(self):
        self.assertEqual(totals(" Ada , +001.20 \nAda,0.80\nada,-0.25\n"),
                         {"Ada": Decimal("2.00"), "ada": Decimal("-0.25")})

    def test_bad_row_width_or_name(self):
        self.assertEqual(totals("missing\nextra,2,field\n,9\n   ,4\nvalid,2\n"),
                         {"valid": Decimal("2")})

    def test_invalid_amounts_skipped_without_losing_good_rows(self):
        bad = ("", ".5", "1.", "1e2", "NaN", "Infinity", "-Infinity", "$3", "1_000", "++1", "word", "١", "１２")
        for value in bad:
            with self.subTest(value=value):
                self.assertEqual(totals(f"valid,1\nbad,{value}\nvalid,2"),
                                 {"valid": Decimal("3")})

    def test_zero_is_retained(self):
        self.assertEqual(totals("zero,-0.00\nother,7\nother,-7"),
                         {"zero": Decimal("0"), "other": Decimal("0")})

    def test_crlf_and_final_record_without_newline(self):
        self.assertEqual(totals("a,1\r\nb,2\r\na,3"),
                         {"a": Decimal("4"), "b": Decimal("2")})
