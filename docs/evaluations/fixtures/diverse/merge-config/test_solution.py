import copy
import unittest

from solution import merge_config


class MergeConfigTests(unittest.TestCase):
    def test_nested_merge_retains_and_adds_keys(self):
        self.assertEqual(merge_config(
            {'service': {'host': 'localhost', 'limits': {'cpu': 2, 'ram': 8}}, 'theme': 'dark'},
            {'service': {'limits': {'cpu': 4}, 'port': 7000}, 'enabled': True}),
            {'service': {'host': 'localhost', 'limits': {'cpu': 4, 'ram': 8}, 'port': 7000},
             'theme': 'dark', 'enabled': True})

    def test_falsey_values_replace_defaults(self):
        overrides = {'none': None, 'flag': False, 'count': 0, 'text': '', 'items': []}
        self.assertEqual(merge_config(dict.fromkeys(overrides, 'old'), overrides), overrides)

    def test_type_changes_and_lists_replace_whole_values(self):
        self.assertEqual(merge_config(
            {'a': {'old': 1}, 'b': 3, 'c': [{'keep': 1}], 'd': [1, 2]},
            {'a': [2], 'b': {'new': 4}, 'c': [{'new': 2}], 'd': None}),
            {'a': [2], 'b': {'new': 4}, 'c': [{'new': 2}], 'd': None})

    def test_does_not_mutate_inputs(self):
        defaults = {'a': {'x': [1, {'v': 2}], 'y': 3}}
        overrides = {'a': {'y': 9}, 'b': [4]}
        before = copy.deepcopy((defaults, overrides))
        merge_config(defaults, overrides)
        self.assertEqual((defaults, overrides), before)

    def test_nested_result_mutations_never_alias_inputs(self):
        defaults = {'retained': [{'v': [1]}], 'merged': {'left': [2]}, 'replaced': [99]}
        overrides = {'merged': {'right': [{'v': 3}]}, 'replaced': [{'v': [4]}]}
        before = copy.deepcopy((defaults, overrides))
        result = merge_config(defaults, overrides)
        result['retained'][0]['v'].append(5)
        result['merged']['left'].append(6)
        result['merged']['right'][0]['v'] = 7
        result['replaced'][0]['v'].append(8)
        result['extra'] = True
        self.assertEqual((defaults, overrides), before)

    def test_empty_dictionaries_and_fresh_top_level(self):
        defaults = {'nested': {'x': 1}}
        self.assertEqual(merge_config({}, {}), {})
        self.assertEqual(merge_config(defaults, {'nested': {}}), defaults)
        self.assertEqual(merge_config({}, defaults), defaults)
        self.assertIsNot(merge_config(defaults, {}), defaults)
        self.assertIsNot(merge_config({}, defaults), defaults)


if __name__ == '__main__':
    unittest.main()
