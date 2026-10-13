import copy
import unittest
from solution import stable_toposort


class ToposortTests(unittest.TestCase):
    def test_empty_and_single(self):
        self.assertEqual(stable_toposort({}), [])
        self.assertEqual(stable_toposort({"one": []}), ["one"])

    def test_independent_tasks_keep_insertion_order(self):
        self.assertEqual(stable_toposort({"zebra": [], "apple": [], "middle": []}),
                         ["zebra", "apple", "middle"])

    def test_reverse_chain(self):
        self.assertEqual(stable_toposort({"finish": ["work"], "work": ["start"], "start": []}),
                         ["start", "work", "finish"])

    def test_newly_ready_earlier_task_wins(self):
        self.assertEqual(stable_toposort({"a": ["b"], "b": [], "c": []}), ["b", "a", "c"])

    def test_diamond_and_disconnected_order(self):
        graph = {"end": ["left", "right"], "left": ["root"], "side": [],
                 "right": ["root"], "root": []}
        self.assertEqual(stable_toposort(graph), ["side", "root", "left", "right", "end"])

    def test_duplicate_dependencies_and_no_mutation(self):
        graph = {"b": ["a", "a"], "a": []}
        before = copy.deepcopy(graph)
        self.assertEqual(stable_toposort(graph), ["a", "b"])
        self.assertEqual(graph, before)

    def test_unknown_dependency(self):
        for graph in ({"a": ["missing"]}, {"ready": [], "a": ["missing"]}):
            with self.subTest(graph=graph), self.assertRaises(ValueError):
                stable_toposort(graph)

    def test_cycles_including_disconnected_component(self):
        for graph in ({"a": ["a"]}, {"a": ["b"], "b": ["a"]},
                      {"ok": [], "a": ["b"], "b": ["a"]}):
            before = copy.deepcopy(graph)
            with self.subTest(graph=graph), self.assertRaises(ValueError):
                stable_toposort(graph)
            self.assertEqual(graph, before)
