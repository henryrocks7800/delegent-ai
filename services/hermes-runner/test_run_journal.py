from run_journal import RunJournal


def test_completed_reply_and_dispatch_claim_survive_new_process(tmp_path):
    path = tmp_path / 'delivery.db'
    first = RunJournal(path)
    assert first.claim('run-a')
    first.save('run-a', {'done': True, 'segment': 'finished', 'committed': '', 'outcome': 'success'})
    reopened = RunJournal(path)
    assert not reopened.claim('run-a')
    assert reopened.load('run-a')['segment'] == 'finished'
    reopened.acknowledge('run-a')
    assert not reopened.claim('run-a')


def test_only_one_connection_can_claim_dispatch(tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    path = tmp_path / 'delivery.db'
    journal = RunJournal(path)
    with ThreadPoolExecutor(max_workers=8) as pool:
        assert list(pool.map(journal.claim, ['same-run'] * 16)).count(True) == 1


def test_unacknowledged_results_have_no_ttl_or_capacity_eviction(tmp_path):
    journal = RunJournal(tmp_path / 'delivery.db')
    for i in range(100):
        journal.save(str(i), {'done': True, 'segment': str(i)})
    with journal.connect() as conn:
        conn.execute('UPDATE delivery_runs SET updated_at=0')
    journal.acknowledge('99')
    assert journal.load('0')['segment'] == '0'
