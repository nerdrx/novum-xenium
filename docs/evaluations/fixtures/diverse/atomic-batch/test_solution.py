import sqlite3
import unittest
from solution import add_users
class AtomicBatch(unittest.TestCase):
    def setUp(self):
        self.c=sqlite3.connect(":memory:")
        self.c.execute("CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
        self.c.execute("INSERT INTO users VALUES (1, 'existing')")
        self.c.commit()
    def tearDown(self): self.c.close()
    def rows(self): return self.c.execute("SELECT id,name FROM users ORDER BY id").fetchall()
    def test_success(self):
        add_users(self.c, iter([(2,"O'Reilly"),(3,"三")]))
        self.assertEqual(self.rows(),[(1,'existing'),(2,"O'Reilly"),(3,"三")])
        self.assertFalse(self.c.in_transaction)
    def test_duplicate_rolls_back_whole_batch(self):
        with self.assertRaises(sqlite3.IntegrityError): add_users(self.c,[(2,'new'),(1,'duplicate')])
        self.assertEqual(self.rows(),[(1,'existing')]);self.assertFalse(self.c.in_transaction)
    def test_null_rolls_back(self):
        with self.assertRaises(sqlite3.IntegrityError): add_users(self.c,[(2,'new'),(3,None)])
        self.assertEqual(self.rows(),[(1,'existing')])
    def test_empty(self):
        add_users(self.c,[]);self.assertEqual(self.rows(),[(1,'existing')]);self.assertFalse(self.c.in_transaction)
    def test_reusable_after_failure(self):
        with self.assertRaises(sqlite3.IntegrityError): add_users(self.c,[(2,'new'),(1,'bad')])
        add_users(self.c,[(2,'valid')]);self.assertEqual(self.rows(),[(1,'existing'),(2,'valid')])
if __name__=='__main__': unittest.main()
