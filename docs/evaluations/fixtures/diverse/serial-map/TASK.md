Implement the named ES-module export async function mapSeries(items, worker) in solution.mjs. Change only solution.mjs. Use built-in JavaScript capabilities; no packages or setup required.

items is an array, and worker is a callable. No type validation is required. For each array element, invoke worker(item, index) exactly once, using its original zero-based index. Process elements strictly sequentially: wait for one worker result to settle successfully before calling the next worker. Workers may return ordinary synchronous values or promises.

Return a promise resolving to a new array of the worker results, in original input order. Preserve result identity and falsey results (including undefined). Do not mutate the input array or its elements. For empty input resolve to [] without calling worker.

If a worker throws synchronously or its promise rejects, stop immediately: never call any later worker, and reject mapSeries with that exact thrown/rejected error object, without wrapping it. Prior successfully completed work need not be undone. No parallel processing is allowed.

Run python3 qa_check.py (or node --test test_solution.mjs). Do not modify the tests or runner. Tests use controlled deferred promises, without timing sleeps. The runner limits total test time to 15 seconds.
